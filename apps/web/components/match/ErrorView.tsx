"use client";
/** PRD: every failure lands on a plain message with one action that moves the user forward. */
import type { UiError } from "../../lib/errors-ui";
import { S } from "../../lib/strings";
import css from "./match.module.css";

export function ErrorView(props: {
  error: UiError;
  offline: boolean;
  onRetry: () => void;
  onOpenClip: () => void;
  onTryAnother: () => void;
  onSignIn: () => void;
}) {
  const { error } = props;
  return (
    <div className={css.errorBox} role="alert" data-testid="error" data-code={error.code}>
      <span>{error.message}</span>
      <div className={css.actions}>
        {(error.action === "retry" || error.action === "openClipAndRetry") && (
          <button
            type="button"
            className={`${css.btn} ${css.primary}`}
            onClick={props.onRetry}
            disabled={props.offline}
          >
            {S.actions.retry}
          </button>
        )}
        {(error.action === "openClip" || error.action === "openClipAndRetry") && (
          <button type="button" className={css.btn} onClick={props.onOpenClip}>
            {S.actions.openClip}
          </button>
        )}
        {(error.action === "tryAnother" ||
          error.action === "focusLink" ||
          error.action === "focusGoal") && (
          <button
            type="button"
            className={`${css.btn} ${css.primary}`}
            onClick={props.onTryAnother}
          >
            {error.action === "focusGoal"
              ? S.actions.focusGoal
              : error.action === "focusLink"
                ? S.actions.focusLink
                : S.actions.tryAnother}
          </button>
        )}
        {error.action === "signIn" && (
          <button type="button" className={`${css.btn} ${css.primary}`} onClick={props.onSignIn}>
            {S.actions.signIn}
          </button>
        )}
        {error.action === "retryWhenOnline" && (
          <button
            type="button"
            className={`${css.btn} ${css.primary}`}
            onClick={props.onRetry}
            disabled={props.offline}
          >
            {S.retryWhenOnline}
          </button>
        )}
      </div>
    </div>
  );
}
