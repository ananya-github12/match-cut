"use client";
/**
 * Playbook page (PRD-playbooks.md, Frontend additions): channel input; progress with stages and
 * "watching 3 of 10"; then the scatter, rule cards with evidence and example clips, house style
 * and what the edit doesn't explain (always visible), the apply panel, and Save as skill.
 * The channel's name and subscribers appear as soon as the API resolves it (before the job runs).
 */
import { PLAYBOOK_WARNINGS, type PlaybookWarningCode } from "@match-cut/core/errors";
import type { PlaybookResponse } from "@match-cut/core/playbooks/api";
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
    .replace("{days}", "7");
}

const ts = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const secondsOf = (mmss: string) => {
  const [m, s] = mmss.split(":").map(Number);
  return (m ?? 0) * 60 + (s ?? 0);
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
  const [player, setPlayer] = useState<{ id: string; start: number } | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillState, setSkillState] = useState<"idle" | "saving" | "saved">("idle");
  const [skillError, setSkillError] = useState<UiError | null>(null);
  const reported = useRef<string | null>(null);
  const idemKey = useRef(newIdempotencyKey());

  const ctx = useCallback(
    (): EventContext => ({ project_id: "standalone", platform, entry_point: "playbook_page" }),
    [platform],
  );

  const onUpdate = useCallback(
    (p: PlaybookResponse) => {
      setPlaybook(p);
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

  // Resume the playbook this tab was following (e.g. after a reload).
  useEffect(() => {
    const id = session.get();
    if (!id || params.get("channel")) return;
    void getPlaybook(id)
      .then((p) => {
        setPlaybook(p);
        if (p.status === "queued" || p.status === "processing") setWatchId(p.id);
      })
      .catch(() => session.set(null));
  }, [params]);

  const start = async (days = windowDays) => {
    setBusy(true);
    setError(null);
    setSkillState("idle");
    setPlayer(null);
    try {
      const { status, playbook: p } = await createPlaybook(
        { source: { channel: channel.trim() }, window_days: days },
        idemKey.current,
      );
      idemKey.current = newIdempotencyKey();
      track("playbook_started", ctx(), { playbook_id: p.id, repeat: status === 200 });
      session.set(p.id);
      onUpdate(p);
      setWatchId(status === 200 ? null : p.id);
      setSkillName(p.channel ? `${p.channel.title} playbook` : "");
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
      setError(uiError(f.code, f.retryAfterSeconds));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!playbook) return;
    setCancelling(true);
    try {
      await deletePlaybook(playbook.id);
      setPlaybook({ ...playbook, status: "cancelled", stage: null });
      setWatchId(null);
      session.set(null);
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
  const titles = useMemo(
    () => new Map((playbook?.videos ?? []).map((v) => [v.id, v.title])),
    [playbook?.videos],
  );
  const play = (videoId: string, at: string, feature: string) => {
    setPlayer({ id: videoId, start: secondsOf(at) });
    track("rule_example_played", ctx(), { playbook_id: playbook?.id, feature, video_id: videoId });
  };

  return (
    <div className={css.page}>
      <Nav current="playbooks" />
      <div>
        <h1 className={css.title}>{P.pageTitle}</h1>
        <p className={css.muted}>{P.intro}</p>
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
          {error && (
            <div className={css.error} role="alert" id="pb-error">
              {error.message}
            </div>
          )}
        </form>
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
            <span data-testid="stage-label">
              {playbook.stage === "watching" && playbook.progress
                ? P.watching(playbook.progress.done, playbook.progress.total)
                : (P.stages[playbook.stage ?? "queued"] ?? P.stages.queued)}
            </span>
          </div>
          <div className="visually-hidden" aria-live="polite">
            {P.stages[playbook.stage ?? "queued"]}
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
          <div className={css.actions}>
            <button type="button" className={css.btn} onClick={cancel} disabled={cancelling}>
              {P.cancel}
            </button>
          </div>
        </div>
      )}
      {timedOut && <div className={css.note}>{P.timedOut}</div>}

      {playbook?.status === "cancelled" && (
        <div className={css.card}>
          <div>{P.cancelled}</div>
          <div className={css.actions}>
            <button type="button" className={css.btn} onClick={reset}>
              {P.newPlaybook}
            </button>
          </div>
        </div>
      )}

      {playbook?.status === "failed" && (
        <div className={css.card} data-testid="playbook-error">
          {playbook.not_enough_data ? (
            <>
              <h2 className={css.sectionTitle}>{P.notEnoughTitle}</h2>
              <div className={css.error} role="alert">
                {uiError("NOT_ENOUGH_DATA").message}
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
                    P.foundShorts,
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
                {windowDays < 180 && (
                  <button
                    type="button"
                    className={`${css.btn} ${css.primary}`}
                    onClick={() => {
                      setWindowDays(180);
                      void start(180);
                    }}
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
                {uiError(playbook.error?.code ?? "INTERNAL").message}
              </div>
              <div className={css.actions}>
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
          {playbook.warnings.map((w) => {
            const text = playbookWarningText(w.code, playbook);
            return text ? (
              <div key={w.code} className={css.note} data-testid="playbook-warning">
                {text}
              </div>
            ) : null;
          })}

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
            <p className={css.muted}>{P.rulesCaveat}</p>
            {playbook.rules && playbook.rules.length > 0 ? (
              <div className={css.rules}>
                {playbook.rules.map((r) => (
                  <article key={`${r.feature}=${r.value}`} className={css.rule} data-testid="rule">
                    <div className={css.ruleHead}>
                      <span className={css.ruleTitle}>{r.title}</span>
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
                            onClick={() => play(ex.video_id, ex.timestamp, r.feature)}
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
                          onClick={() => play(r.counterexample!, "00:00", r.feature)}
                        >
                          {`"${titles.get(r.counterexample) ?? r.counterexample}"`}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className={css.note}>{P.noRules}</div>
            )}
            {player && (
              <iframe
                key={`${player.id}@${player.start}`}
                className={css.player}
                title={P.playerTitle}
                // Privacy-enhanced embed; it plays only after the user picks an example.
                src={`https://www.youtube-nocookie.com/embed/${player.id}?rel=0&autoplay=1&start=${player.start}`}
                allow="autoplay; encrypted-media; picture-in-picture"
                data-testid="example-player"
              />
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
                      onChange={(e) => setSkillName(e.target.value)}
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
                {skillState === "saved" && (
                  <div className={css.note} role="status">
                    {P.saved} <a href="/skills">{P.navSkills}</a>
                  </div>
                )}
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
