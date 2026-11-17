"use client";
/**
 * Input panel. PRD "Screens and components > Input panel": link with local validation as the user
 * types, preview from the precheck, goal with counter, format and length prefilled from the
 * project, clip range, advanced options, and "Match this style".
 */
import { GOAL_MAX_CHARS } from "@match-cut/core/schemas";
import { formatTimecode, parseTimecode } from "@match-cut/core/timecode";
import { parseYouTubeSource } from "@match-cut/core/youtube-url";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { ApiFailure, getVideo, type CreateBody, type VideoPreview } from "../../lib/api";
import { uiError, type UiError } from "../../lib/errors-ui";
import { FORMATS, LANGUAGES, LENGTHS, S } from "../../lib/strings";
import css from "./match.module.css";

export interface FormValues {
  url: string;
  goal: string;
  format: string;
  length: string;
  clipOpen: boolean;
  clipStart: string;
  clipEnd: string;
  language: string;
  detail: "standard" | "deep";
}

export interface InputPanelHandle {
  focusLink(): void;
  focusGoal(): void;
  openClip(): void;
}

const MAX_CLIP_SECONDS = 600;
const CLIP_SUGGEST_ABOVE = 180;

export function toCreateBody(v: FormValues): CreateBody {
  const start = v.clipStart.trim() ? parseTimecode(v.clipStart) : null;
  const end = v.clipEnd.trim() ? parseTimecode(v.clipEnd) : null;
  const clip =
    v.clipOpen && (start !== null || end !== null)
      ? {
          ...(start !== null ? { start_seconds: start } : {}),
          ...(end !== null ? { end_seconds: end } : {}),
        }
      : undefined;
  return {
    source: { url: v.url.trim() },
    ...(v.goal.trim() ? { goal: v.goal.trim() } : {}),
    target: {
      format: v.format,
      ...(v.length !== "match" ? { length_seconds: Number(v.length) } : {}),
    },
    ...(clip ? { clip } : {}),
    output_language: v.language,
    detail: v.detail,
  };
}

/** Local clip checks; the API repeats them (PRD: end after start, at least 3 s, within 10 minutes). */
function clipProblem(v: FormValues, required: boolean): string | null {
  if (!v.clipOpen) return required ? S.clipRequired : null;
  const start = v.clipStart.trim() ? parseTimecode(v.clipStart) : null;
  const end = v.clipEnd.trim() ? parseTimecode(v.clipEnd) : null;
  if ((v.clipStart.trim() && start === null) || (v.clipEnd.trim() && end === null))
    return S.clipInvalid;
  if (required && start === null && end === null) return S.clipRequired;
  const s = start ?? 0;
  if (end !== null && (end - s < 3 || end - s > MAX_CLIP_SECONDS)) {
    return uiError("INVALID_CLIP_RANGE").message;
  }
  return null;
}

export function InputPanel(props: {
  values: FormValues;
  onChange: (v: FormValues) => void;
  onSubmit: () => void;
  submitting: boolean;
  /** Error from the last submit that the user fixes here. */
  fieldError: UiError | null;
  rateLimitSeconds: number;
  offline: boolean;
  onLinkValidated: (p: { valid: boolean; error_code?: string; duration_seconds?: number }) => void;
  onBlockedChange: (blocked: boolean) => void;
  onSeeExample: () => void;
  handleRef: Ref<InputPanelHandle>;
}) {
  const { values: v, onChange } = props;
  const linkRef = useRef<HTMLInputElement>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const clipRef = useRef<HTMLDetailsElement>(null);
  const [preview, setPreview] = useState<VideoPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const set = (patch: Partial<FormValues>) => onChange({ ...v, ...patch });

  useImperativeHandle(props.handleRef, () => ({
    focusLink: () => linkRef.current?.focus(),
    focusGoal: () => goalRef.current?.focus(),
    openClip: () => {
      onChange({ ...v, clipOpen: true });
      setTimeout(() => clipRef.current?.querySelector("input")?.focus(), 0);
    },
  }));

  const trimmed = v.url.trim();
  const parsed = trimmed ? parseYouTubeSource(trimmed) : null;
  const localError = parsed && !parsed.ok ? uiError(parsed.code) : null;
  const videoId = parsed?.ok ? parsed.videoId : null;

  // Preview from the precheck endpoint, debounced 400 ms (PRD "Data fetching").
  const onValidated = useRef(props.onLinkValidated);
  onValidated.current = props.onLinkValidated;
  useEffect(() => {
    setPreview(null);
    if (!trimmed) return;
    if (!videoId) {
      const t = setTimeout(
        () => onValidated.current({ valid: false, error_code: localError?.code }),
        400,
      );
      return () => clearTimeout(t);
    }
    const controller = new AbortController();
    const t = setTimeout(() => {
      setChecking(true);
      getVideo(videoId, controller.signal)
        .then((p) => {
          setPreview(p);
          onValidated.current({
            valid: !p.blocking_error,
            error_code: p.blocking_error?.code,
            duration_seconds: p.video?.duration_seconds,
          });
        })
        .catch((e) => {
          if (controller.signal.aborted) return;
          // Preview failures don't block: the API checks again on submit.
          onValidated.current({
            valid: true,
            error_code: e instanceof ApiFailure ? e.code : undefined,
          });
        })
        .finally(() => !controller.signal.aborted && setChecking(false));
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(t);
      setChecking(false);
    };
  }, [videoId, trimmed]);

  const blocking = preview?.blocking_error ? uiError(preview.blocking_error.code) : null;
  const requiresClip = !!preview?.requires_clip_range;
  const duration = preview?.video?.duration_seconds ?? null;
  const clipError = clipProblem(v, requiresClip);
  const goalOver = v.goal.length > GOAL_MAX_CHARS;
  const linkError =
    localError ??
    blocking ??
    (props.fieldError &&
    [
      "INVALID_URL",
      "UNSUPPORTED_SOURCE",
      "VIDEO_NOT_FOUND",
      "VIDEO_NOT_PUBLIC",
      "VIDEO_RESTRICTED",
      "LIVE_NOT_SUPPORTED",
      "NO_ANALYZABLE_CONTENT",
    ].includes(props.fieldError.code)
      ? props.fieldError
      : null);

  const onBlocked = useRef(props.onBlockedChange);
  onBlocked.current = props.onBlockedChange;
  useEffect(() => onBlocked.current(!!blocking), [blocking]);

  useEffect(() => {
    if (requiresClip && !v.clipOpen) onChange({ ...v, clipOpen: true });
  }, [requiresClip]);

  const canSubmit =
    !!videoId &&
    !blocking &&
    !goalOver &&
    !clipError &&
    !props.submitting &&
    props.rateLimitSeconds <= 0 &&
    !props.offline;

  const onKeyDown = (e: React.KeyboardEvent) => {
    // PRD keyboard: Cmd or Ctrl + Enter submits from any input field.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSubmit) props.onSubmit();
    }
  };

  const clipFieldError =
    props.fieldError && ["INVALID_CLIP_RANGE", "VIDEO_TOO_LONG"].includes(props.fieldError.code)
      ? props.fieldError.message
      : null;

  return (
    <form
      className={css.session}
      style={{ boxShadow: "none", border: 0, padding: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) props.onSubmit();
      }}
      onKeyDown={onKeyDown}
      noValidate
      aria-label="Match a reference"
    >
      {!trimmed && (
        <div className={css.empty} data-testid="empty-state">
          <div>{S.emptyTitle}</div>
          <ol>
            {S.emptySteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <button type="button" className={css.linkBtn} onClick={props.onSeeExample}>
            {S.seeExample}
          </button>
        </div>
      )}

      <div className={css.field}>
        <label className={css.label} htmlFor="mc-link">
          {S.linkLabel}
        </label>
        <input
          id="mc-link"
          ref={linkRef}
          className={`${css.input} ${linkError ? css.invalid : ""}`}
          value={v.url}
          placeholder={S.linkPlaceholder}
          inputMode="url"
          autoComplete="off"
          aria-invalid={!!linkError}
          aria-describedby={linkError ? "mc-link-error" : undefined}
          onChange={(e) => set({ url: e.target.value })}
        />
        {linkError && (
          <div id="mc-link-error" className={css.fieldError} role="alert" data-testid="link-error">
            <span>{linkError.message}</span>
            {(linkError.action === "tryAnother" || linkError.action === "focusLink") && (
              <button
                type="button"
                className={css.linkBtn}
                onClick={() => linkRef.current?.select()}
              >
                {linkError.action === "tryAnother" ? S.actions.tryAnother : S.actions.focusLink}
              </button>
            )}
          </div>
        )}
        {checking && !preview && <div className={css.muted}>{S.checkingLink}</div>}
      </div>

      {preview?.video && (
        <div className={css.preview} data-testid="preview">
          <img
            className={css.thumb}
            alt=""
            src={
              preview.video.thumbnail_url ??
              `https://i.ytimg.com/vi/${preview.video.id}/hqdefault.jpg`
            }
            onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
          />
          <div className={css.previewText}>
            <div className={css.previewTitle}>{preview.video.title}</div>
            <div className={css.muted}>
              {preview.video.channel} · {formatTimecode(preview.video.duration_seconds)}
            </div>
            {duration !== null && duration > CLIP_SUGGEST_ABOVE && !requiresClip && !v.clipOpen && (
              <div className={css.muted}>
                {S.clipSuggested}{" "}
                <button
                  type="button"
                  className={css.linkBtn}
                  onClick={() => set({ clipOpen: true })}
                >
                  {S.actions.openClip}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className={css.field}>
        <label className={css.label} htmlFor="mc-goal">
          {S.goalLabel}
        </label>
        <textarea
          id="mc-goal"
          ref={goalRef}
          className={`${css.textarea} ${goalOver ? css.invalid : ""}`}
          rows={3}
          value={v.goal}
          placeholder={S.goalPlaceholder}
          aria-describedby="mc-goal-help"
          onChange={(e) => set({ goal: e.target.value })}
        />
        <div id="mc-goal-help" className={css.muted}>
          {S.goalHelp}
        </div>
        {v.goal.length >= 1200 && (
          <div className={`${css.counter} ${goalOver ? css.counterOver : ""}`} aria-live="polite">
            {v.goal.length.toLocaleString("en")} / {GOAL_MAX_CHARS.toLocaleString("en")}
          </div>
        )}
        {(goalOver || props.fieldError?.code === "GOAL_TOO_LONG") && (
          <div className={css.fieldError} role="alert">
            {uiError("GOAL_TOO_LONG").message}
          </div>
        )}
      </div>

      <div className={css.row}>
        <div className={css.field}>
          <label className={css.label} htmlFor="mc-format">
            {S.formatLabel}
          </label>
          <select
            id="mc-format"
            className={css.select}
            value={v.format}
            onChange={(e) => set({ format: e.target.value })}
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className={css.field}>
          <label className={css.label} htmlFor="mc-length">
            {S.lengthLabel}
          </label>
          <select
            id="mc-length"
            className={css.select}
            value={v.length}
            onChange={(e) => set({ length: e.target.value })}
          >
            {LENGTHS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <details
        ref={clipRef}
        className={css.details}
        open={v.clipOpen}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          if (open !== v.clipOpen) set({ clipOpen: open });
        }}
      >
        <summary>{S.clipLabel}</summary>
        <div className={css.detailsBody}>
          <div className={css.row}>
            <div className={css.field}>
              <label className={css.label} htmlFor="mc-clip-start">
                {S.clipStart}
              </label>
              <input
                id="mc-clip-start"
                className={css.input}
                placeholder="0:00"
                value={v.clipStart}
                onChange={(e) => set({ clipStart: e.target.value })}
              />
            </div>
            <div className={css.field}>
              <label className={css.label} htmlFor="mc-clip-end">
                {S.clipEnd}
              </label>
              <input
                id="mc-clip-end"
                className={css.input}
                placeholder="1:30"
                value={v.clipEnd}
                onChange={(e) => set({ clipEnd: e.target.value })}
              />
            </div>
          </div>
          <div className={css.muted}>{S.clipHelp}</div>
        </div>
      </details>
      {(clipError || clipFieldError) && (v.clipOpen || requiresClip || clipFieldError) && (
        <div className={css.fieldError} role="alert" data-testid="clip-error">
          {clipFieldError ?? clipError}
        </div>
      )}

      <details className={css.details}>
        <summary>{S.advancedLabel}</summary>
        <div className={css.detailsBody}>
          <div className={css.field}>
            <label className={css.label} htmlFor="mc-language">
              {S.languageLabel}
            </label>
            <select
              id="mc-language"
              className={css.select}
              value={v.language}
              onChange={(e) => set({ language: e.target.value })}
            >
              {LANGUAGES.map((l) => (
                <option key={l.tag} value={l.tag}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <fieldset className={css.field} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className={css.label}>{S.detailLabel}</legend>
            <label>
              <input
                type="radio"
                name="mc-detail"
                checked={v.detail === "standard"}
                onChange={() => set({ detail: "standard" })}
              />{" "}
              {S.detailStandard}
            </label>
            <label>
              <input
                type="radio"
                name="mc-detail"
                checked={v.detail === "deep"}
                onChange={() => set({ detail: "deep" })}
              />{" "}
              {S.detailDeep} <span className={css.muted}>({S.detailDeepNote})</span>
            </label>
          </fieldset>
        </div>
      </details>

      {props.offline && (
        <div className={css.notice} role="status">
          {S.offline}
        </div>
      )}
      {props.rateLimitSeconds > 0 && props.fieldError?.code === "RATE_LIMITED" && (
        <div className={css.errorBox} role="alert" data-testid="rate-limited">
          <span>{props.fieldError.message}</span>
        </div>
      )}

      <div className={css.actions}>
        <button
          type="submit"
          className={`${css.btn} ${css.primary}`}
          disabled={!canSubmit}
          data-testid="match-button"
        >
          {props.rateLimitSeconds > 0 ? S.actions.countdown(props.rateLimitSeconds) : S.primary}
        </button>
      </div>
    </form>
  );
}
