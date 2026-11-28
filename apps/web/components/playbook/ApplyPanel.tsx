"use client";
/**
 * Apply panel (PRD-playbooks.md, Frontend additions): goal, format and length; returns a prompt
 * and shot list with Copy and Send to Director. Used for a playbook and for a saved skill, so the
 * heading level comes from where it sits.
 */
import type { ApplyResponse } from "@match-cut/core/playbooks/apply";
import { GOAL_MAX_CHARS } from "@match-cut/core/schemas";
import { useState } from "react";
import { ApiFailure } from "../../lib/api";
import { applyWarningText, uiError, type UiError } from "../../lib/errors-ui";
import type { ApplyBody } from "../../lib/playbook-api";
import { P } from "../../lib/playbook-strings";
import { FORMATS, S } from "../../lib/strings";
import css from "./playbook.module.css";

export function ApplyPanel(props: {
  idPrefix: string;
  /** The panel's heading level: 2 on the playbook page, 3 inside a skill row. */
  level: 2 | 3;
  apply: (body: ApplyBody) => Promise<ApplyResponse>;
  onApplied: (result: ApplyResponse, body: ApplyBody) => void;
  onSendToDirector: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [format, setFormat] = useState("match");
  const [length, setLength] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [result, setResult] = useState<ApplyResponse | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [sent, setSent] = useState(false);

  const lengthSeconds = length === "" ? null : Number(length);
  const lengthValid =
    lengthSeconds === null ||
    (Number.isInteger(lengthSeconds) && lengthSeconds >= 5 && lengthSeconds <= 600);
  const H = `h${props.level}` as const;
  const Sub = `h${props.level + 1}` as "h3" | "h4";
  const id = (s: string) => `${props.idPrefix}-${s}`;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setCopy("idle");
    setSent(false);
    const body: ApplyBody = {
      ...(goal.trim() ? { goal: goal.trim() } : {}),
      target: { format, length_seconds: lengthSeconds },
    };
    try {
      const r = await props.apply(body);
      setResult(r);
      props.onApplied(r, body);
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
      setError(uiError(f.code, f.retryAfterSeconds));
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.cardboard_prompt);
      setCopy("copied");
    } catch {
      // Blocked clipboard: say so instead of claiming it worked.
      setCopy("failed");
    }
  };

  return (
    <div className={css.card} data-testid="apply-panel" id={props.idPrefix}>
      <H className={css.sectionTitle}>{P.applyTitle}</H>
      <div className={css.field}>
        <label className={css.label} htmlFor={id("goal")}>
          {P.goalLabel}
        </label>
        <textarea
          id={id("goal")}
          className={css.input}
          rows={2}
          maxLength={GOAL_MAX_CHARS}
          placeholder={P.goalPlaceholder}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </div>
      <div className={css.row}>
        <div className={css.field}>
          <label className={css.label} htmlFor={id("format")}>
            {P.formatLabel}
          </label>
          <select
            id={id("format")}
            className={css.input}
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.value === "match" ? P.formatMatch : f.label}
              </option>
            ))}
          </select>
        </div>
        <div className={css.field}>
          <label className={css.label} htmlFor={id("length")}>
            {P.lengthLabel}
          </label>
          <input
            id={id("length")}
            className={css.input}
            inputMode="numeric"
            placeholder={P.lengthAny}
            value={length}
            onChange={(e) => setLength(e.target.value.replace(/[^0-9]/g, ""))}
            aria-invalid={!lengthValid}
            aria-describedby={lengthValid ? undefined : id("length-error")}
          />
        </div>
        <button
          type="button"
          className={`${css.btn} ${css.primary}`}
          onClick={submit}
          disabled={busy || !lengthValid}
          data-testid="apply-button"
        >
          {busy ? P.applying : P.apply}
        </button>
      </div>
      {!lengthValid && (
        <div className={css.fieldError} id={id("length-error")}>
          {P.lengthInvalid}
        </div>
      )}
      {error && (
        <div className={css.error} role="alert">
          {error.message}
        </div>
      )}
      <div className="visually-hidden" role="status">
        {result && !busy ? P.applyDone : ""}
      </div>
      {result && (
        <div className={css.card} data-testid="apply-result">
          <Sub className={css.sectionTitle}>{P.promptTitle}</Sub>
          <pre className={css.prompt} data-testid="apply-prompt">
            {result.cardboard_prompt}
          </pre>
          <div className={css.actions}>
            <button
              type="button"
              className={`${css.btn} ${css.primary}`}
              onClick={() => {
                setSent(true);
                props.onSendToDirector();
              }}
            >
              {S.sendToDirector}
            </button>
            <button type="button" className={css.btn} onClick={copyPrompt}>
              {copy === "copied" ? S.copied : S.copy}
            </button>
          </div>
          <div role="status">
            {copy === "failed" && <div className={css.note}>{P.copyFailed}</div>}
            {sent && <div className={css.note}>{S.directorAck}</div>}
          </div>
          {result.warnings.map((w) => {
            const text = applyWarningText(w.code);
            return text ? (
              <div key={w.code} className={css.note}>
                {text}
              </div>
            ) : null;
          })}
          {result.shot_list.length > 0 && (
            <>
              <Sub className={css.sectionTitle}>{P.shotsTitle}</Sub>
              <ol className={css.list} data-testid="apply-shots">
                {result.shot_list.map((s, i) => (
                  <li key={i}>
                    {s.shot}
                    <div className={css.muted}>{P.shotLine(s.duration_seconds, s.framing)}</div>
                    {s.notes && <div className={css.muted}>{s.notes}</div>}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}
