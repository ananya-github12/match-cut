"use client";
/**
 * Progress view. PRD: stage label from the API's `stage`, elapsed time and an estimate based on
 * video length, Cancel. It renders as a chat message that updates in place, so the user can keep
 * working. Stage changes are announced through a polite live region.
 */
import { useEffect, useState } from "react";
import type { Connection } from "../../lib/useBriefWatch";
import { S } from "../../lib/strings";
import css from "./match.module.css";

const ORDER = ["prechecking", "watching", "writing_prompt", "validating"];

export function estimateFor(seconds: number | null): string {
  if (seconds === null || seconds <= 60) return S.estimateShort;
  if (seconds <= 180) return S.estimateMedium;
  return S.estimateLong;
}

export function ProgressView(props: {
  stage: string | null;
  startedAt: number;
  analyzedSeconds: number | null;
  connection: Connection;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const stage = props.stage ?? "prechecking";
  const label = S.stages[stage] ?? S.stages.prechecking;
  const index = Math.max(0, ORDER.indexOf(stage));
  const elapsed = Math.max(0, Math.floor((now - props.startedAt) / 1000));

  return (
    <div className={css.progress} data-testid="progress">
      <div className={css.stage}>
        <span className={css.spinner} aria-hidden="true" />
        <span data-testid="stage-label">{label}</span>
      </div>
      <div className="visually-hidden" aria-live="polite">
        {label}
      </div>
      <div className={css.steps} aria-hidden="true">
        {ORDER.map((s, i) => (
          <div key={s} className={`${css.step} ${i <= index ? css.stepDone : ""}`} />
        ))}
      </div>
      <div className={css.muted}>
        <span data-testid="elapsed">{S.elapsed(elapsed)}</span> ·{" "}
        {estimateFor(props.analyzedSeconds)}
      </div>
      {props.connection === "offline" && (
        <div className={css.notice} role="status">
          {S.offlineWaiting}
        </div>
      )}
      <div className={css.muted}>{S.keepWorking}</div>
      <div className={css.actions}>
        <button
          type="button"
          className={css.btn}
          onClick={props.onCancel}
          disabled={props.cancelling}
        >
          {S.cancel}
        </button>
      </div>
    </div>
  );
}
