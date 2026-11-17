"use client";
/**
 * Result view. PRD "Result view, in order": prompt card (editable; Send to Director, Copy,
 * Regenerate), warnings as quiet notes above the prompt, reference player with a beat timeline,
 * breakdown rows, Before you start and Watch-outs, then a footer with model and time, feedback and
 * Delete brief. Player rules: privacy-enhanced embed, never autoplay on load, thumbnail and
 * "Open on YouTube" when embedding is disabled.
 */
import type { BriefResponse } from "@match-cut/core/schemas";
import { formatTimecode } from "@match-cut/core/timecode";
import { useEffect, useRef, useState } from "react";
import type { RegenerateBody } from "../../lib/api";
import { warningText, type UiError } from "../../lib/errors-ui";
import { FORMATS, LANGUAGES, LENGTHS, S } from "../../lib/strings";
import css from "./match.module.css";

export interface RegenValues {
  goal: string;
  format: string;
  length: string;
  language: string;
}

const mmssToSeconds = (v: string) => {
  const m = /^(\d+):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

export function ResultView(props: {
  brief: BriefResponse;
  isExample: boolean;
  readOnly: boolean;
  regenerating: string | null;
  regenError: UiError | null;
  regenRateSeconds: number;
  editedText: string | null;
  regenDefaults: RegenValues;
  onEdit: (text: string) => void;
  onEditDone: () => void;
  onReset: () => void;
  onSendToDirector: (text: string) => void;
  onCopy: () => void;
  onRegenerate: (body: RegenerateBody, changed: string[]) => void;
  onBeat: (index: number) => void;
  onFeedback: (helpful: boolean, reasons: string[], text: string) => void;
  onDelete: () => void;
  onStartOver: () => void;
}) {
  const { brief } = props;
  const partial = brief.status === "partial";
  const original = brief.cardboard_prompt ?? "";
  const text = props.editedText ?? original;
  const edited = props.editedText !== null && props.editedText !== original;
  const [copied, setCopied] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regen, setRegen] = useState<RegenValues>(props.regenDefaults);
  const [beat, setBeat] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<"none" | "reasons" | "done">("none");
  const [reasons, setReasons] = useState<string[]>([]);
  const [feedbackText, setFeedbackText] = useState("");
  const [sheetOpen, setSheetOpen] = useState(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setRegen(props.regenDefaults), [props.regenDefaults]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard can be blocked; the event still records intent */
    }
    props.onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // PRD keyboard: Cmd or Ctrl + Shift + C copies the prompt when the result is focused.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c" && text) {
      e.preventDefault();
      void copy();
    }
  };

  const range = brief.video.analyzed_range;
  const rangeStart = range?.start_seconds ?? 0;
  const total = brief.breakdown ? Math.max(1, mmssToSeconds(brief.breakdown.format.duration)) : 1;
  const embedDisabled = brief.warnings.some((w) => w.code === "EMBED_DISABLED");
  const videoUrl = `https://www.youtube.com/watch?v=${brief.video.id}`;

  const selectBeat = (i: number) => {
    setBeat(i);
    props.onBeat(i);
    const b = brief.breakdown?.beats[i];
    if (!b || !iframeRef.current?.contentWindow) return;
    // Seek, then play: playback starts only after a beat is selected (never on load).
    const seconds = rangeStart + mmssToSeconds(b.start);
    const send = (func: string, args: unknown[]) =>
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func, args }),
        "*",
      );
    send("seekTo", [seconds, true]);
    send("playVideo", []);
  };

  const notes = brief.warnings
    .filter((w) => w.code !== "EMBED_DISABLED")
    .map((w) => ({ code: w.code, text: warningText(w.code, { duration: range?.end_seconds }) }))
    .filter((w) => w.text);

  const submitRegen = () => {
    const d = props.regenDefaults;
    const changed = (["goal", "format", "length", "language"] as const).filter(
      (k) => regen[k] !== d[k],
    );
    props.onRegenerate(
      {
        goal: regen.goal,
        target: {
          format: regen.format,
          length_seconds: regen.length === "match" ? null : Number(regen.length),
        },
        output_language: regen.language,
      },
      changed,
    );
    setRegenOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={`${css.result} ${sheetOpen ? css.sheet : ""}`}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      data-testid="result"
      aria-label="Match Cut result"
    >
      {sheetOpen && (
        <div className={css.sheetBar}>
          <button type="button" className={css.btn} onClick={() => setSheetOpen(false)}>
            {S.backToChat}
          </button>
        </div>
      )}
      {!sheetOpen && (
        <button type="button" className={css.btn} onClick={() => setSheetOpen(true)}>
          {S.promptTitle}
        </button>
      )}
      {props.isExample && <span className={css.exampleLabel}>{S.exampleLabel}</span>}

      {notes.map((n) => (
        <div key={n.code} className={css.notice} data-testid={`warning-${n.code}`}>
          {n.text}
        </div>
      ))}

      {partial ? (
        <div className={css.errorBox} data-testid="partial">
          <span>{S.partial}</span>
          <div className={css.actions}>
            <button
              type="button"
              className={`${css.btn} ${css.primary}`}
              disabled={!!props.regenerating || props.regenRateSeconds > 0}
              onClick={() => props.onRegenerate({}, [])}
            >
              {S.regeneratePrompt}
            </button>
          </div>
          {props.regenerating && (
            <div className={css.muted} aria-live="polite">
              {S.regenerating}
            </div>
          )}
          {props.regenError && <div role="alert">{props.regenError.message}</div>}
        </div>
      ) : (
        <section className={css.promptCard} aria-labelledby="mc-prompt-title">
          <div className={css.header}>
            <span id="mc-prompt-title" className={css.title}>
              {S.promptTitle}
            </span>
            {edited && !props.readOnly && (
              <button type="button" className={css.linkBtn} onClick={props.onReset}>
                {S.resetToOriginal}
              </button>
            )}
          </div>
          {props.regenerating ? (
            <div className={css.progress} data-testid="regenerating">
              <div className={css.stage}>
                <span className={css.spinner} aria-hidden="true" />
                <span>{S.stages[props.regenerating] ?? S.regenerating}</span>
              </div>
              <div className="visually-hidden" aria-live="polite">
                {S.regenerating}
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="mc-prompt" className="visually-hidden">
                {S.promptTitle}
              </label>
              <textarea
                id="mc-prompt"
                className={`${css.textarea} ${css.promptText}`}
                value={text}
                readOnly={props.readOnly || props.isExample}
                onChange={(e) => props.onEdit(e.target.value)}
                onBlur={props.onEditDone}
                data-testid="prompt"
              />
              {props.readOnly && <div className={css.muted}>{S.readOnlyMobile}</div>}
              <div className={css.actions}>
                {!props.isExample && (
                  <button
                    type="button"
                    className={`${css.btn} ${css.primary}`}
                    onClick={() => props.onSendToDirector(text)}
                  >
                    {S.sendToDirector}
                  </button>
                )}
                <button type="button" className={css.btn} onClick={copy} aria-live="polite">
                  {copied ? S.copied : S.copy}
                </button>
                {!props.isExample && (
                  <button
                    type="button"
                    className={css.btn}
                    aria-expanded={regenOpen}
                    disabled={props.regenRateSeconds > 0}
                    onClick={() => setRegenOpen((o) => !o)}
                  >
                    {props.regenRateSeconds > 0
                      ? S.actions.countdown(props.regenRateSeconds)
                      : S.regenerate}
                  </button>
                )}
              </div>
              {props.regenError && (
                <div className={css.fieldError} role="alert">
                  {props.regenError.message}
                </div>
              )}
              {regenOpen && (
                <div className={css.detailsBody} data-testid="regen-panel">
                  <div className={css.label}>{S.regenerateTitle}</div>
                  {edited && (
                    <div className={css.notice} role="alert" data-testid="regen-warning">
                      {S.regenerateEditedWarning}
                    </div>
                  )}
                  <div className={css.field}>
                    <label className={css.label} htmlFor="mc-regen-goal">
                      {S.goalLabel}
                    </label>
                    <textarea
                      id="mc-regen-goal"
                      className={css.textarea}
                      value={regen.goal}
                      onChange={(e) => setRegen({ ...regen, goal: e.target.value })}
                    />
                  </div>
                  <div className={css.row}>
                    <div className={css.field}>
                      <label className={css.label} htmlFor="mc-regen-format">
                        {S.formatLabel}
                      </label>
                      <select
                        id="mc-regen-format"
                        className={css.select}
                        value={regen.format}
                        onChange={(e) => setRegen({ ...regen, format: e.target.value })}
                      >
                        {FORMATS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={css.field}>
                      <label className={css.label} htmlFor="mc-regen-length">
                        {S.lengthLabel}
                      </label>
                      <select
                        id="mc-regen-length"
                        className={css.select}
                        value={regen.length}
                        onChange={(e) => setRegen({ ...regen, length: e.target.value })}
                      >
                        {LENGTHS.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={css.field}>
                      <label className={css.label} htmlFor="mc-regen-language">
                        {S.languageLabel}
                      </label>
                      <select
                        id="mc-regen-language"
                        className={css.select}
                        value={regen.language}
                        onChange={(e) => setRegen({ ...regen, language: e.target.value })}
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.tag} value={l.tag}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className={css.actions}>
                    <button
                      type="button"
                      className={`${css.btn} ${css.primary}`}
                      onClick={submitRegen}
                    >
                      {S.regenerateGo}
                    </button>
                    <button type="button" className={css.btn} onClick={() => setRegenOpen(false)}>
                      {S.cancel}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section aria-label={S.playerTitle} className={css.field}>
        {embedDisabled || props.isExample ? (
          <div className={css.playerFallback} data-testid="player-fallback">
            {!props.isExample && (
              <img alt="" src={`https://i.ytimg.com/vi/${brief.video.id}/hqdefault.jpg`} />
            )}
            <div>
              {embedDisabled && <div className={css.notice}>{warningText("EMBED_DISABLED")}</div>}
              {!props.isExample && (
                <a
                  href={videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${css.btn} ${css.primary}`}
                >
                  {S.openOnYouTube}
                </a>
              )}
              {props.isExample && <span className={css.muted}>{brief.video.title}</span>}
            </div>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            className={css.player}
            title={brief.video.title ?? S.playerTitle}
            // Privacy-enhanced embed; no autoplay. The JS API lets beats seek the player.
            src={`https://www.youtube-nocookie.com/embed/${brief.video.id}?enablejsapi=1&rel=0&start=${rangeStart}`}
            allow="encrypted-media; picture-in-picture"
            loading="lazy"
            data-testid="player"
          />
        )}
        {brief.breakdown && (
          <>
            <div className={css.label}>{S.beatsLabel}</div>
            <div className={css.beats} role="group" aria-label={S.beatsLabel}>
              {brief.breakdown.beats.map((b, i) => {
                const start = mmssToSeconds(b.start);
                const end = mmssToSeconds(b.end);
                return (
                  <button
                    key={`${b.start}-${i}`}
                    type="button"
                    className={`${css.beat} ${beat === i ? css.beatSelected : ""}`}
                    style={{ flexGrow: Math.max(1, end - start) / total, flexBasis: 0 }}
                    aria-label={`${b.label}, ${formatTimecode(start)} to ${formatTimecode(end)}`}
                    aria-pressed={beat === i}
                    onClick={() => selectBeat(i)}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
            {beat !== null && brief.breakdown.beats[beat] && (
              <div className={css.beatDetail} aria-live="polite" data-testid="beat-detail">
                <strong>{brief.breakdown.beats[beat]!.label}</strong>:{" "}
                {brief.breakdown.beats[beat]!.what_happens}
              </div>
            )}
          </>
        )}
      </section>

      {brief.breakdown && (
        <section aria-labelledby="mc-breakdown-title">
          <div id="mc-breakdown-title" className={css.title}>
            {S.breakdownTitle}
          </div>
          <p style={{ margin: "6px 0 10px" }}>{brief.breakdown.summary}</p>
          <dl className={css.dl}>
            <dt>{S.rows.video_type}</dt>
            <dd>{brief.breakdown.video_type}</dd>
            <dt>{S.rows.hook}</dt>
            <dd>{brief.breakdown.hook}</dd>
            {(
              [
                "pacing",
                "framing",
                "transitions",
                "text_and_graphics",
                "audio",
                "delivery",
                "look",
              ] as const
            ).map((k) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{S.rows[k]}</dt>
                <dd>{brief.breakdown!.style[k]}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {!!brief.assets_needed?.length && (
        <section>
          <div className={css.title}>{S.assetsTitle}</div>
          <ul className={css.list}>
            {brief.assets_needed.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      )}
      {!!brief.watch_outs?.length && (
        <section>
          <div className={css.title}>{S.watchOutsTitle}</div>
          <ul className={css.list}>
            {brief.watch_outs.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className={css.footer}>
        <div className={css.muted} data-testid="footer-meta">
          {S.footerMeta(
            brief.meta.model ?? "",
            brief.meta.timings_ms.total !== undefined ? brief.meta.timings_ms.total / 1000 : null,
          )}
        </div>
        {!props.isExample && (
          <>
            {feedback === "done" ? (
              <div className={css.muted} role="status">
                {S.feedbackThanks}
              </div>
            ) : (
              <div className={css.actions}>
                <button
                  type="button"
                  className={css.btn}
                  onClick={() => {
                    props.onFeedback(true, [], "");
                    setFeedback("done");
                  }}
                >
                  {S.helpful}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  aria-expanded={feedback === "reasons"}
                  onClick={() => setFeedback("reasons")}
                >
                  {S.notHelpful}
                </button>
              </div>
            )}
            {feedback === "reasons" && (
              <fieldset
                className={css.detailsBody}
                style={{ border: 0, padding: 0, margin: 0 }}
                data-testid="feedback-reasons"
              >
                <legend className="visually-hidden">{S.notHelpful}</legend>
                {Object.entries(S.feedbackReasons).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={reasons.includes(key)}
                      onChange={(e) =>
                        setReasons(
                          e.target.checked ? [...reasons, key] : reasons.filter((r) => r !== key),
                        )
                      }
                    />{" "}
                    {label}
                  </label>
                ))}
                <label className={css.field}>
                  <span className={css.label}>{S.feedbackDetails}</span>
                  <textarea
                    className={css.textarea}
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                  />
                </label>
                <div className={css.actions}>
                  <button
                    type="button"
                    className={`${css.btn} ${css.primary}`}
                    onClick={() => {
                      props.onFeedback(false, reasons, feedbackText);
                      setFeedback("done");
                    }}
                  >
                    {S.feedbackSubmit}
                  </button>
                </div>
              </fieldset>
            )}
          </>
        )}
        <div className={css.actions}>
          <button type="button" className={css.btn} onClick={props.onStartOver}>
            {S.startOver}
          </button>
          {!props.isExample && (
            <button
              type="button"
              className={`${css.btn} ${css.danger}`}
              onClick={() => dialogRef.current?.showModal()}
            >
              {S.deleteBrief}
            </button>
          )}
        </div>
      </footer>

      <dialog ref={dialogRef} className={css.dialog} aria-labelledby="mc-delete-title">
        <div id="mc-delete-title" className={css.title}>
          {S.deleteConfirmTitle}
        </div>
        <p>{S.deleteConfirmBody}</p>
        <div className={css.actions}>
          <button
            type="button"
            className={`${css.btn} ${css.primary}`}
            onClick={() => {
              dialogRef.current?.close();
              props.onDelete();
            }}
          >
            {S.deleteConfirm}
          </button>
          <button
            type="button"
            className={css.btn}
            onClick={() => dialogRef.current?.close()}
            autoFocus
          >
            {S.deleteCancel}
          </button>
        </div>
      </dialog>
    </div>
  );
}
