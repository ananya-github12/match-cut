"use client";
/**
 * Playbook page (PRD-playbooks.md, Frontend additions): channel input; progress with stages and
 * "watching 3 of 10"; then the scatter, rule cards with evidence and example clips, house style
 * and what the edit doesn't explain (always visible), the apply panel, and Save as skill.
 * The channel's name and subscribers appear as soon as the API resolves it (before the job runs).
 */
import { PLAYBOOK_WARNINGS, type PlaybookWarningCode } from "@match-cut/core/errors";
import { MIN_AGE_DAYS, type PlaybookResponse } from "@match-cut/core/playbooks/api";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectPlatform, track, type EventContext } from "../../lib/analytics";
import { ApiFailure, newIdempotencyKey } from "../../lib/api";
import { uiError, type UiError } from "../../lib/errors-ui";
import {
  applyPlaybook,
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  saveSkill,
} from "../../lib/playbook-api";
import { P } from "../../lib/playbook-strings";
import { S } from "../../lib/strings";
import { usePlaybookWatch } from "../../lib/usePlaybookWatch";
import { ApplyPanel } from "./ApplyPanel";
import { Nav } from "./Nav";
import { Scatter } from "./Scatter";
import css from "./playbook.module.css";

const ACTIVE_KEY = "mc_active_playbook";
const ORDER = [
  "resolving_channel",
  "fetching_stats",
  "scoring",
  "watching",
  "extracting",
  "comparing",
  "writing_playbook",
  "validating",
];
const WINDOWS = P.windowOptions.map((o) => o.value);
/** IDs from the API, checked before they go into an embed URL. */
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

const session = {
  get: () => {
    try {
      return sessionStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  },
  set: (id: string | null) => {
    try {
      if (id) sessionStorage.setItem(ACTIVE_KEY, id);
      else sessionStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* storage can be blocked */
    }
  },
};

/** Warning copy from the PRD table (never server text), with its numbers filled in. */
export function playbookWarningText(code: string, p: PlaybookResponse): string | null {
  if (!(code in PLAYBOOK_WARNINGS)) return null;
  const skipped = p.videos.filter(
    (v) => (v.group === "outlier" || v.group === "typical") && !v.compared,
  ).length;
  return PLAYBOOK_WARNINGS[code as PlaybookWarningCode]
    .replace("{count}", String(code === "VIDEOS_SKIPPED" ? skipped : (p.window?.too_new ?? 0)))
    .replace("{days}", String(MIN_AGE_DAYS));
}

/** What to send to build this playbook again: its channel and its window. */
function requestFor(p: PlaybookResponse): { channel: string; days: number } | null {
  const channel = p.channel?.handle
    ? `@${p.channel.handle}`
    : p.channel
      ? `https://www.youtube.com/channel/${p.channel.id}`
      : null;
  if (!channel) return null;
  const span = p.window ? (Date.parse(p.window.to) - Date.parse(p.window.from)) / 86_400_000 : 90;
  const days = WINDOWS.reduce((best, d) => (Math.abs(d - span) < Math.abs(best - span) ? d : best));
  return { channel, days };
}

const ts = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const secondsOf = (mmss: string) => {
  const [m, s] = mmss.split(":").map(Number);
  const total = (m ?? 0) * 60 + (s ?? 0);
  return Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;
};

export function PlaybookPage() {
  const params = useSearchParams();
  const platform = useMemo(detectPlatform, []);
  const [channel, setChannel] = useState(params.get("channel") ?? "");
  const [windowDays, setWindowDays] = useState(90);
  const [playbook, setPlaybook] = useState<PlaybookResponse | null>(null);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [player, setPlayer] = useState<{ id: string; start: number; rule: string } | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillState, setSkillState] = useState<"idle" | "saving" | "saved">("idle");
  const [skillError, setSkillError] = useState<UiError | null>(null);
  const reported = useRef<string | null>(null);
  const idemKey = useRef(newIdempotencyKey());
  /** What the current idempotency key was last sent for: a different request gets a new key. */
  const idemFor = useRef<string | null>(null);
  const channelInput = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  const playerRef = useRef<HTMLDivElement>(null);

  const ctx = useCallback(
    (): EventContext => ({ project_id: "standalone", platform, entry_point: "playbook_page" }),
    [platform],
  );

  const onUpdate = useCallback(
    (p: PlaybookResponse) => {
      setPlaybook(p);
      if (p.channel) setSkillName((n) => n || `${p.channel!.title} playbook`);
      if (reported.current === `${p.id}:${p.status}`) return;
      if (p.status === "succeeded") {
        reported.current = `${p.id}:${p.status}`;
        track("playbook_completed", ctx(), {
          playbook_id: p.id,
          rules: p.rules?.length ?? 0,
          cached: p.meta.cached,
        });
      } else if (p.status === "failed") {
        reported.current = `${p.id}:${p.status}`;
        track("playbook_failed", ctx(), { playbook_id: p.id, code: p.error?.code ?? null });
      }
    },
    [ctx],
  );
  const { connection, timedOut } = usePlaybookWatch(watchId, onUpdate, () => {
    session.set(null);
    setWatchId(null);
    setPlaybook(null);
  });

  // Resume the playbook this tab was following (e.g. after a reload), unless the user has
  // already started another one by the time it loads.
  useEffect(() => {
    const id = session.get();
    if (!id || params.get("channel")) return;
    let ignore = false;
    void getPlaybook(id)
      .then((p) => {
        if (ignore || submitted.current) return;
        onUpdate(p);
        if (p.status === "queued" || p.status === "processing") setWatchId(p.id);
      })
      .catch((e) => {
        if (e instanceof ApiFailure && e.status === 404) session.set(null);
      });
    return () => {
      ignore = true;
    };
  }, [params, onUpdate]);

  // The example player opens inside the rule that was clicked; bring it into view.
  useEffect(() => {
    if (!player) return;
    playerRef.current?.scrollIntoView?.({ block: "nearest" });
    playerRef.current?.focus();
  }, [player]);

  const start = async (req = { channel: channel.trim(), days: windowDays }) => {
    submitted.current = true;
    setBusy(true);
    setError(null);
    setSkillState("idle");
    setSkillError(null);
    setSkillName("");
    setPlayer(null);
    // A retry of the same request keeps its key (a lost response returns the same playbook);
    // a different channel or window must never be answered with the earlier playbook.
    const what = JSON.stringify([req.channel, req.days]);
    if (idemFor.current !== null && idemFor.current !== what) {
      idemKey.current = newIdempotencyKey();
    }
    idemFor.current = what;
    try {
      const { status, playbook: p } = await createPlaybook(
        { source: { channel: req.channel }, window_days: req.days },
        idemKey.current,
      );
      idemKey.current = newIdempotencyKey();
      track("playbook_started", ctx(), { playbook_id: p.id, repeat: status === 200 });
      session.set(p.id);
      setChannel(req.channel);
      setWindowDays(req.days);
      onUpdate(p);
      setWatchId(status === 200 ? null : p.id);
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
      const ui = uiError(f.code, f.retryAfterSeconds);
      setError(ui);
      // Fix-the-input errors put the cursor back in the channel field.
      if (ui.action === "focusLink") requestAnimationFrame(() => channelInput.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!playbook) return;
    setCancelling(true);
    setError(null);
    try {
      await deletePlaybook(playbook.id);
      setPlaybook({ ...playbook, status: "cancelled", stage: null });
      setWatchId(null);
      session.set(null);
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
      setError(uiError(f.code, f.retryAfterSeconds));
    } finally {
      setCancelling(false);
    }
  };

  const reset = () => {
    session.set(null);
    setWatchId(null);
    setPlaybook(null);
    setError(null);
    setPlayer(null);
  };

  const save = async () => {
    if (!playbook) return;
    setSkillState("saving");
    setSkillError(null);
    try {
      const skill = await saveSkill(skillName.trim(), playbook.id);
      setSkillState("saved");
      track("skill_saved", ctx(), { playbook_id: playbook.id, skill_id: skill.id });
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
      setSkillError(uiError(f.code, f.retryAfterSeconds));
      setSkillState("idle");
    }
  };

  const running = playbook && (playbook.status === "queued" || playbook.status === "processing");
  const again = playbook ? requestFor(playbook) : null;
  const titles = useMemo(
    () => new Map((playbook?.videos ?? []).map((v) => [v.id, v.title])),
    [playbook?.videos],
  );
  const play = (videoId: string, at: string, rule: string, feature: string) => {
    if (!VIDEO_ID.test(videoId)) return;
    setPlayer({ id: videoId, start: secondsOf(at), rule });
    track("rule_example_played", ctx(), { playbook_id: playbook?.id, feature, video_id: videoId });
  };
  const stageLabel = running
    ? playbook.stage === "watching" && playbook.progress
      ? P.watching(playbook.progress.done, playbook.progress.total)
      : (P.stages[playbook.stage ?? "queued"] ?? P.stages.queued)
    : "";
  const failure =
    playbook?.status === "failed" ? uiError(playbook.error?.code ?? "INTERNAL") : null;

  return (
    <div className={css.page}>
      <Nav current="playbooks" />
      <div>
        <h1 className={css.title}>{P.pageTitle}</h1>
        <p className={css.muted}>{P.intro}</p>
      </div>
      {/* Mounted from the start, so screen readers announce the first stage too. */}
      <div className="visually-hidden" aria-live="polite">
        {stageLabel}
      </div>

      {!playbook && (
        <form
          className={css.card}
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className={css.row}>
            <div className={css.field}>
              <label className={css.label} htmlFor="pb-channel">
                {P.channelLabel}
              </label>
              <input
                ref={channelInput}
                id="pb-channel"
                className={css.input}
                placeholder={P.channelPlaceholder}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                aria-invalid={error?.action === "focusLink"}
                aria-describedby={error ? "pb-error" : undefined}
                maxLength={2048}
                autoComplete="off"
              />
            </div>
            <div className={css.field} style={{ flex: "0 1 160px" }}>
              <label className={css.label} htmlFor="pb-window">
                {P.windowLabel}
              </label>
              <select
                id="pb-window"
                className={css.input}
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value))}
              >
                {P.windowOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className={`${css.btn} ${css.primary}`}
              disabled={busy || !channel.trim()}
              data-testid="playbook-button"
            >
              {P.start}
            </button>
          </div>
          <div className={css.muted}>{P.publicOnly}</div>
        </form>
      )}

      {/* Shown wherever the user is: the form, the failed card or a running playbook. */}
      {error && (
        <div className={css.error} role="alert" id="pb-error">
          {error.message}
        </div>
      )}

      {playbook?.channel && (
        <div className={css.header} data-testid="channel-preview">
          <span className={css.channelName}>{playbook.channel.title}</span>
          {playbook.channel.handle && <span className={css.muted}>@{playbook.channel.handle}</span>}
          <span className={css.muted}>
            {P.subscribers(
              playbook.channel.subscriber_count_rounded,
              playbook.channel.subscriber_count_hidden,
            )}
          </span>
        </div>
      )}

      {running && (
        <div className={css.card} data-testid="progress">
          <div className={css.stage}>
            <span className={css.spinner} aria-hidden="true" />
            <span data-testid="stage-label">{stageLabel}</span>
          </div>
          <div className={css.steps} aria-hidden="true">
            {ORDER.map((s, i) => (
              <div
                key={s}
                className={`${css.step} ${i <= ORDER.indexOf(playbook.stage ?? "") ? css.stepDone : ""}`}
              />
            ))}
          </div>
          <div className={css.muted}>{P.estimate}</div>
          {connection === "offline" && <div className={css.note}>{S.offlineWaiting}</div>}
          {timedOut && <div className={css.note}>{P.timedOut}</div>}
          <div className={css.actions}>
            <button type="button" className={css.btn} onClick={cancel} disabled={cancelling}>
              {P.cancel}
            </button>
          </div>
        </div>
      )}

      {playbook?.status === "cancelled" && (
        <div className={css.card}>
          <div role="status">{P.cancelled}</div>
          <div className={css.actions}>
            <button type="button" className={css.btn} onClick={reset}>
              {P.newPlaybook}
            </button>
          </div>
        </div>
      )}

      {playbook?.status === "failed" && failure && (
        <div className={css.card} data-testid="playbook-error">
          {playbook.not_enough_data ? (
            <>
              <h2 className={css.sectionTitle}>{P.notEnoughTitle}</h2>
              <div className={css.error} role="alert">
                {failure.message}
              </div>
              <ul className={css.list}>
                {playbook.not_enough_data.reasons.map((r) => (
                  <li key={r}>{P.reasons[r] ?? r}</li>
                ))}
              </ul>
              <ul className={css.list}>
                <li>
                  {P.found(
                    playbook.not_enough_data.found.shorts_eligible,
                    playbook.not_enough_data.minimums.shorts_eligible,
                    P.foundShorts(MIN_AGE_DAYS),
                  )}
                </li>
                <li>
                  {P.found(
                    playbook.not_enough_data.found.outliers,
                    playbook.not_enough_data.minimums.outliers,
                    P.foundBreakouts,
                  )}
                </li>
                <li>
                  {P.found(
                    playbook.not_enough_data.found.typical,
                    playbook.not_enough_data.minimums.typical,
                    P.foundTypical,
                  )}
                </li>
              </ul>
              <div className={css.actions}>
                {again && again.days < 180 && (
                  <button
                    type="button"
                    className={`${css.btn} ${css.primary}`}
                    disabled={busy}
                    onClick={() => void start({ channel: again.channel, days: 180 })}
                  >
                    {P.tryLonger}
                  </button>
                )}
                <a className={css.btn} href="/">
                  {P.singleVideo}
                </a>
                <button type="button" className={css.btn} onClick={reset}>
                  {P.newPlaybook}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={css.error} role="alert">
                {failure.message}
              </div>
              <div className={css.actions}>
                {again && playbook.error?.retryable && (
                  <button
                    type="button"
                    className={`${css.btn} ${css.primary}`}
                    disabled={busy}
                    onClick={() => void start(again)}
                  >
                    {P.retry}
                  </button>
                )}
                <button type="button" className={css.btn} onClick={reset}>
                  {P.newPlaybook}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {playbook?.status === "succeeded" && (
        <>
          {playbook.window && (
            <div className={css.muted}>
              {P.windowSummary(
                playbook.window.from,
                playbook.window.to,
                playbook.window.shorts_eligible,
              )}
            </div>
          )}

          <section className={css.card} aria-labelledby="pb-scatter">
            <h2 className={css.sectionTitle} id="pb-scatter">
              {P.scatterTitle}
            </h2>
            <Scatter playbook={playbook} />
          </section>

          <section className={css.card} aria-labelledby="pb-rules">
            <h2 className={css.sectionTitle} id="pb-rules">
              {P.rulesTitle}
            </h2>
            <p className={css.note}>{P.rulesCaveat}</p>
            {/* The playbook's caveats (small sample, shared topic...) sit with its rules. */}
            {playbook.warnings.map((w) => {
              const text = playbookWarningText(w.code, playbook);
              return text ? (
                <div key={w.code} className={css.note} data-testid="playbook-warning">
                  {text}
                </div>
              ) : null;
            })}
            {playbook.rules && playbook.rules.length > 0 ? (
              <div className={css.rules}>
                {playbook.rules.map((r) => {
                  const key = `${r.feature}=${r.value}`;
                  return (
                    <article key={key} className={css.rule} data-testid="rule">
                      <div className={css.ruleHead}>
                        <h3 className={css.ruleTitle}>{r.title}</h3>
                        <span
                          className={`${css.badge} ${r.confidence === "medium" ? css.badgeMedium : ""}`}
                        >
                          {P.confidence[r.confidence]}
                        </span>
                      </div>
                      <div className={css.evidence} data-testid="evidence">
                        {P.evidence(
                          r.evidence.outliers_with,
                          r.evidence.outliers_known,
                          r.evidence.typical_with,
                          r.evidence.typical_known,
                        )}
                      </div>
                      <div>{r.how_to}</div>
                      {r.examples.length > 0 && (
                        <div className={css.examples}>
                          {r.examples.map((ex) => (
                            <button
                              key={`${ex.video_id}@${ex.timestamp}`}
                              type="button"
                              className={css.linkBtn}
                              onClick={() => play(ex.video_id, ex.timestamp, key, r.feature)}
                            >
                              {P.watchExample(
                                `"${titles.get(ex.video_id) ?? ex.video_id}"`,
                                ts(secondsOf(ex.timestamp)),
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                      {r.counterexample && (
                        <div className={css.muted}>
                          {P.counterexample}{" "}
                          <button
                            type="button"
                            className={css.linkBtn}
                            onClick={() => play(r.counterexample!, "00:00", key, r.feature)}
                          >
                            {`"${titles.get(r.counterexample) ?? r.counterexample}"`}
                          </button>
                        </div>
                      )}
                      {player?.rule === key && (
                        <div className={css.playerWrap} ref={playerRef} tabIndex={-1}>
                          <iframe
                            key={`${player.id}@${player.start}`}
                            className={css.player}
                            title={P.playerTitle(titles.get(player.id) ?? player.id)}
                            // Privacy-enhanced embed; it plays only after the user picks an example.
                            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(player.id)}?rel=0&autoplay=1&start=${player.start}`}
                            allow="autoplay; encrypted-media; picture-in-picture"
                            data-testid="example-player"
                          />
                          {/* For creators who turned off embedding. */}
                          <a
                            href={`https://www.youtube.com/watch?v=${encodeURIComponent(player.id)}&t=${player.start}s`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {P.watchOnYouTube}
                          </a>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className={css.note}>{P.noRules}</div>
            )}
          </section>

          <section className={css.card} aria-labelledby="pb-house">
            <h2 className={css.sectionTitle} id="pb-house">
              {P.houseStyleTitle}
            </h2>
            <p>{playbook.house_style || P.houseStyleNone}</p>
            <h2 className={css.sectionTitle}>{P.notExplainedTitle}</h2>
            <ul className={css.list} data-testid="not-explained">
              {(playbook.not_explained ?? []).map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </section>

          {playbook.rules && playbook.rules.length > 0 && (
            <>
              <ApplyPanel
                idPrefix="pb-apply"
                level={2}
                apply={(body) => applyPlaybook(playbook.id, body)}
                onApplied={(r, body) =>
                  track("playbook_applied", ctx(), {
                    playbook_id: playbook.id,
                    has_goal: Boolean(body.goal),
                    format: body.target?.format ?? "match",
                    shots: r.shot_list.length,
                    cached: r.meta.cached,
                  })
                }
                onSendToDirector={() =>
                  track("prompt_sent_to_director", ctx(), { playbook_id: playbook.id })
                }
              />
              <section className={css.card} aria-labelledby="pb-save">
                <h2 className={css.sectionTitle} id="pb-save">
                  {P.saveTitle}
                </h2>
                <p className={css.muted}>{P.saveHelp}</p>
                <div className={css.row}>
                  <div className={css.field}>
                    <label className={css.label} htmlFor="pb-skill-name">
                      {P.nameLabel}
                    </label>
                    <input
                      id="pb-skill-name"
                      className={css.input}
                      maxLength={80}
                      value={skillName}
                      onChange={(e) => {
                        setSkillName(e.target.value);
                        if (skillState === "saved") setSkillState("idle");
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className={css.btn}
                    onClick={save}
                    disabled={!skillName.trim() || skillState !== "idle"}
                    data-testid="save-skill"
                  >
                    {P.save}
                  </button>
                </div>
                <div role="status">
                  {skillState === "saved" && (
                    <div className={css.note}>
                      {P.saved} <a href="/skills">{P.navSkills}</a>
                    </div>
                  )}
                </div>
                {skillError && (
                  <div className={css.error} role="alert">
                    {skillError.message}
                  </div>
                )}
              </section>
            </>
          )}
          <div className={css.actions}>
            <button type="button" className={css.btn} onClick={reset}>
              {P.newPlaybook}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
