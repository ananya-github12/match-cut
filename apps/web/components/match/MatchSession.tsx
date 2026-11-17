"use client";
/**
 * One Match Cut session inside the chat. PRD "User flow and states": input -> (checked) ->
 * processing -> result, with blocked, failed and partial states; cancel returns to the input with
 * values kept; a cache hit goes straight to the result. The user always lands on a result or a
 * message with one action.
 */
import type { BriefResponse } from "@match-cut/core/schemas";
import { formatTimecode, parseTimecode } from "@match-cut/core/timecode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { track, detectPlatform, type EntryPoint, type EventContext } from "../../lib/analytics";
import {
  ApiFailure,
  createBrief,
  deleteBrief,
  getBrief,
  newIdempotencyKey,
  regenerateBrief,
  type RegenerateBody,
} from "../../lib/api";
import { INPUT_CODES, uiError, type UiError } from "../../lib/errors-ui";
import { activeBriefKey, editKey, inputsKey, store, type Project } from "../../lib/project";
import { SAMPLE_BRIEF } from "../../lib/sample";
import { S } from "../../lib/strings";
import { useBriefWatch } from "../../lib/useBriefWatch";
import { ErrorView } from "./ErrorView";
import { InputPanel, toCreateBody, type FormValues, type InputPanelHandle } from "./InputPanel";
import { ProgressView } from "./ProgressView";
import { ResultView, type RegenValues } from "./ResultView";
import css from "./match.module.css";

type View = "loading" | "input" | "progress" | "result" | "error";

function defaultLanguage(): string {
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";
  return lang?.split("-")[0] || "en";
}

function useCountdown() {
  const [until, setUntil] = useState(0);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) return;
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setUntil(0);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  return { left, start: (seconds: number) => setUntil(Date.now() + seconds * 1000) };
}

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function MatchSession(props: {
  project: Project;
  entry: EntryPoint;
  initialUrl?: string;
  initialGoal?: string;
  autoStart?: boolean;
  resumeBriefId?: string;
  onSendToDirector: (prompt: string) => void;
  onRemove: () => void;
}) {
  const { project } = props;
  const platform = useMemo(detectPlatform, []);
  const [values, setValues] = useState<FormValues>({
    url: props.initialUrl ?? "",
    goal: props.initialGoal ?? "",
    format: project.aspect,
    length: project.lengthSeconds ? String(project.lengthSeconds) : "match",
    clipOpen: false,
    clipStart: "",
    clipEnd: "",
    language: defaultLanguage(),
    detail: "standard",
  });
  const [view, setView] = useState<View>(props.resumeBriefId ? "loading" : "input");
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [isExample, setIsExample] = useState(false);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [watchNonce, setWatchNonce] = useState(0);
  const [error, setError] = useState<UiError | null>(null);
  const [fieldError, setFieldError] = useState<UiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<UiError | null>(null);
  const [edited, setEdited] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [, setBlocked] = useState(false);
  const rate = useCountdown();
  const regenRate = useCountdown();
  const online = useOnline();
  const inputRef = useRef<InputPanelHandle>(null);
  const idemKey = useRef<string | null>(null);
  const briefIdRef = useRef<string | undefined>(undefined);
  const lastStage = useRef<string | null>(null);
  const editBaseline = useRef<string>("");
  /** The link the last link_validated event was for. */
  const validatedUrl = useRef<string | null>(null);

  const ctx = useCallback(
    (): EventContext => ({
      project_id: project.id,
      platform,
      entry_point: props.entry,
      ...(briefIdRef.current ? { brief_id: briefIdRef.current } : {}),
    }),
    [project.id, platform, props.entry],
  );
  const secondsWaited = () => Math.round((Date.now() - startedAt) / 1000);

  // match_opened once per session.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track("match_opened", ctx());
  }, [ctx]);

  const savedInputs = (id: string): RegenValues | null => {
    try {
      return JSON.parse(store.get(inputsKey(id)) ?? "null");
    } catch {
      return null;
    }
  };

  const showBrief = useCallback(
    (b: BriefResponse, opts: { fresh?: boolean } = {}) => {
      briefIdRef.current = b.id;
      setBrief(b);
      lastStage.current = b.stage;
      if (b.status === "succeeded" || b.status === "partial") {
        if (regenerating) {
          setRegenerating(null);
          if (b.status === "succeeded") {
            store.del(editKey(b.id));
            setEdited(null);
          }
        } else if (opts.fresh) {
          track(b.status === "succeeded" ? "brief_succeeded" : "brief_partial", ctx(), {
            ...(b.status === "succeeded"
              ? { cached: b.meta.cached, warning_codes: b.warnings.map((w) => w.code) }
              : {}),
            seconds_waited: secondsWaited(),
          });
        }
        setEdited(store.get(editKey(b.id)));
        setView("result");
      } else if (b.status === "failed") {
        setRegenerating(null);
        if (opts.fresh)
          track("brief_failed", ctx(), {
            error_code: b.error?.code,
            seconds_waited: secondsWaited(),
          });
        setError(uiError(b.error?.code ?? "INTERNAL"));
        setView("error");
      } else if (b.status === "cancelled") {
        setView("input");
      } else if (regenerating !== null) {
        setRegenerating(b.stage ?? "writing_prompt");
      } else {
        setView("progress");
      }
    },
    [ctx, regenerating, startedAt],
  );

  const watch = useBriefWatch(
    watchId,
    (b) => showBrief(b, { fresh: true }),
    () => {
      store.del(activeBriefKey(project.id));
      props.onRemove();
    },
    watchNonce,
  );

  useEffect(() => {
    if (!watch.timedOut) return;
    setRegenerating(null);
    setError(uiError("UPSTREAM_TIMEOUT"));
    setView("error");
  }, [watch.timedOut]);

  // Resume the active brief after a reload or reopening the app.
  useEffect(() => {
    const id = props.resumeBriefId;
    if (!id) return;
    getBrief(id)
      .then((b) => {
        const saved = savedInputs(id);
        if (saved) setValues((v) => ({ ...v, ...saved }));
        showBrief(b);
        if (b.status === "queued" || b.status === "processing") {
          setWatchId(id);
        }
      })
      .catch(() => {
        store.del(activeBriefKey(project.id));
        props.onRemove();
      });
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (!navigator.onLine) {
      setError(uiError("OFFLINE"));
      setView("error");
      return;
    }
    const body = toCreateBody(values);
    // One key per submit: a double click sends the same key, so it creates one job.
    idemKey.current ??= newIdempotencyKey();
    setSubmitting(true);
    setFieldError(null);
    setError(null);
    setIsExample(false);
    setStartedAt(Date.now());
    // A fast submit can beat the 400 ms preview debounce; still record the validation.
    if (validatedUrl.current !== body.source.url) {
      validatedUrl.current = body.source.url;
      track("link_validated", ctx(), { valid: true });
    }
    track("brief_requested", ctx(), {
      has_goal: !!body.goal,
      goal_length: body.goal?.length ?? 0,
      format: body.target?.format,
      length_seconds: body.target?.length_seconds ?? null,
      has_clip: !!body.clip,
      detail: body.detail,
    });
    try {
      const { status, brief: b } = await createBrief(body, idemKey.current);
      briefIdRef.current = b.id;
      store.set(activeBriefKey(project.id), b.id);
      store.set(
        inputsKey(b.id),
        JSON.stringify({
          goal: values.goal,
          format: values.format,
          length: values.length,
          language: values.language,
        }),
      );
      if (status === 200) {
        showBrief(b, { fresh: true }); // cache hit: straight to the result, no progress view
      } else {
        setBrief(b);
        setView("progress");
        setWatchId(b.id);
        setWatchNonce((n) => n + 1);
      }
    } catch (e) {
      const code = e instanceof ApiFailure ? e.code : "INTERNAL";
      const ui = uiError(code, e instanceof ApiFailure ? e.retryAfterSeconds : undefined);
      if (code === "RATE_LIMITED") {
        rate.start(ui.retryAfterSeconds ?? 60);
        setFieldError(ui);
      } else if (INPUT_CODES.has(code)) {
        setFieldError(ui);
        if (ui.action === "openClip") inputRef.current?.openClip();
        if (ui.action === "focusGoal") inputRef.current?.focusGoal();
      } else {
        setError(ui);
        setView("error");
      }
    } finally {
      idemKey.current = null;
      setSubmitting(false);
    }
  }, [values, submitting, ctx, project.id, showBrief, rate]);

  // The Director called the tool: start right away (PRD entry point 3).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (props.autoStart && !autoStarted.current) {
      autoStarted.current = true;
      void submit();
    }
  }, [props.autoStart, submit]);

  const cancel = async () => {
    if (!brief) return;
    setCancelling(true);
    track("brief_cancelled", ctx(), {
      stage: brief.stage ?? lastStage.current,
      seconds_waited: secondsWaited(),
    });
    setWatchId(null);
    try {
      await deleteBrief(brief.id);
    } catch {
      /* already finished or gone; return to the input either way */
    }
    store.del(activeBriefKey(project.id));
    setCancelling(false);
    setView("input");
  };

  const regenerate = async (body: RegenerateBody, changed: string[]) => {
    if (!brief) return;
    setRegenError(null);
    track("prompt_regenerated", ctx(), { changed_fields: changed });
    try {
      setRegenerating("writing_prompt");
      const { status, brief: b } = await regenerateBrief(brief.id, body);
      if (body.goal !== undefined) {
        store.set(
          inputsKey(b.id),
          JSON.stringify({
            goal: body.goal,
            format: body.target?.format ?? values.format,
            length:
              body.target?.length_seconds == null ? "match" : String(body.target.length_seconds),
            language: body.output_language ?? values.language,
          }),
        );
      }
      if (status === 200) {
        store.del(editKey(b.id));
        setEdited(null);
        setRegenerating(null);
        setBrief(b);
      } else {
        setBrief({ ...b, breakdown: b.breakdown ?? brief.breakdown });
        setWatchId(b.id);
        setWatchNonce((n) => n + 1);
      }
    } catch (e) {
      setRegenerating(null);
      const code = e instanceof ApiFailure ? e.code : "INTERNAL";
      const ui = uiError(code, e instanceof ApiFailure ? e.retryAfterSeconds : undefined);
      if (code === "RATE_LIMITED") regenRate.start(ui.retryAfterSeconds ?? 60);
      setRegenError(ui);
    }
  };

  const regenDefaults: RegenValues = useMemo(() => {
    const saved = brief ? savedInputs(brief.id) : null;
    return (
      saved ?? {
        goal: values.goal,
        format: values.format,
        length: values.length,
        language: values.language,
      }
    );
  }, [brief?.id, regenerating]);

  const removeBrief = async () => {
    if (!brief) return;
    try {
      await deleteBrief(brief.id);
    } catch {
      /* gone already */
    }
    track("brief_deleted", ctx());
    store.del(activeBriefKey(project.id));
    store.del(editKey(brief.id));
    store.del(inputsKey(brief.id));
    props.onRemove();
  };

  const startOver = () => {
    setBrief(null);
    setIsExample(false);
    setWatchId(null);
    setError(null);
    setView("input");
  };

  const analyzedSeconds = brief?.video.analyzed_range
    ? brief.video.analyzed_range.end_seconds - brief.video.analyzed_range.start_seconds
    : (() => {
        const s = values.clipOpen ? parseTimecode(values.clipStart || "0") : null;
        const e = values.clipOpen && values.clipEnd ? parseTimecode(values.clipEnd) : null;
        return s !== null && e !== null ? e - s : null;
      })();

  return (
    <section
      className={css.session}
      aria-label={S.appName}
      data-testid="match-session"
      data-view={view}
    >
      <div className={css.header}>
        <span className={css.title}>{S.appName}</span>
        {view === "result" && brief?.video.title && (
          <span className={css.muted} title={brief.video.title}>
            {brief.video.duration_seconds !== null
              ? formatTimecode(brief.video.duration_seconds)
              : ""}
          </span>
        )}
      </div>

      {view === "loading" && <div className={css.muted}>{S.checkingLink}</div>}

      {view === "input" && (
        <InputPanel
          values={values}
          onChange={setValues}
          onSubmit={submit}
          submitting={submitting}
          fieldError={fieldError}
          rateLimitSeconds={rate.left}
          offline={!online}
          onLinkValidated={(p) => {
            validatedUrl.current = values.url.trim();
            track("link_validated", ctx(), p);
          }}
          onBlockedChange={setBlocked}
          onSeeExample={() => {
            setIsExample(true);
            setBrief(SAMPLE_BRIEF);
            setView("result");
          }}
          handleRef={inputRef}
        />
      )}

      {view === "progress" && (
        <ProgressView
          stage={brief?.stage ?? null}
          startedAt={startedAt}
          analyzedSeconds={analyzedSeconds}
          connection={watch.connection}
          onCancel={cancel}
          cancelling={cancelling}
        />
      )}

      {view === "error" && error && (
        <ErrorView
          error={error}
          offline={!online}
          onRetry={() => {
            setView("input");
            void submit();
          }}
          onOpenClip={() => {
            setView("input");
            setValues((v) => ({ ...v, clipOpen: true }));
          }}
          onTryAnother={() => {
            setView("input");
            setTimeout(
              () =>
                error.action === "focusGoal"
                  ? inputRef.current?.focusGoal()
                  : inputRef.current?.focusLink(),
              0,
            );
          }}
          onSignIn={() => window.location.reload()}
        />
      )}

      {view === "result" && brief && (
        <ResultView
          brief={brief}
          isExample={isExample}
          readOnly={platform === "mobile_web"}
          regenerating={regenerating}
          regenError={regenError}
          regenRateSeconds={regenRate.left}
          editedText={edited}
          regenDefaults={regenDefaults}
          onEdit={(text) => {
            if (edited === null) editBaseline.current = brief.cardboard_prompt ?? "";
            setEdited(text);
            store.set(editKey(brief.id), text);
          }}
          onEditDone={() => {
            if (edited === null) return;
            const base = editBaseline.current || (brief.cardboard_prompt ?? "");
            let diff = Math.abs(edited.length - base.length);
            for (let i = 0; i < Math.min(edited.length, base.length); i++)
              if (edited[i] !== base[i]) diff++;
            if (diff > 0) track("prompt_edited", ctx(), { chars_changed: diff });
            editBaseline.current = edited;
          }}
          onReset={() => {
            setEdited(null);
            store.del(editKey(brief.id));
          }}
          onSendToDirector={(text) => {
            track("prompt_sent_to_director", ctx(), {
              edited: edited !== null && edited !== brief.cardboard_prompt,
            });
            props.onSendToDirector(text);
          }}
          onCopy={() =>
            track("prompt_copied", ctx(), {
              edited: edited !== null && edited !== brief.cardboard_prompt,
            })
          }
          onRegenerate={regenerate}
          onBeat={(i) => track("beat_clicked", ctx(), { beat_index: i })}
          onFeedback={(helpful, reasons) => track("brief_feedback", ctx(), { helpful, reasons })}
          onDelete={removeBrief}
          onStartOver={startOver}
        />
      )}
    </section>
  );
}
