"use client";
/**
 * Skills list (PRD-playbooks.md, Frontend additions): name, source, last used, Apply. A skill
 * applies without re-watching anything, and keeps working after its playbook or brief is gone.
 * Opening Apply shows how old the rules are and the playbook's caveats, so they're never applied
 * out of context.
 */
import { PLAYBOOK_WARNINGS, type PlaybookWarningCode } from "@match-cut/core/errors";
import type { SkillResponse, SkillSummaryResponse } from "@match-cut/core/playbooks/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { detectPlatform, track, type EventContext } from "../../lib/analytics";
import { ApiFailure } from "../../lib/api";
import { uiError, type UiError } from "../../lib/errors-ui";
import { applySkill, deleteSkill, getSkill, listSkills } from "../../lib/playbook-api";
import { P } from "../../lib/playbook-strings";
import { ApplyPanel } from "./ApplyPanel";
import { Nav } from "./Nav";
import css from "./playbook.module.css";

/** A saved playbook's caveats, from the PRD table. Codes with numbers are left out: those
 * numbers belonged to the playbook, not to the rules. */
function caveats(skill: SkillResponse | undefined): string[] {
  if (!skill || skill.snapshot.type !== "playbook") return [];
  return skill.snapshot.warnings
    .map((w) => PLAYBOOK_WARNINGS[w.code as PlaybookWarningCode] as string | undefined)
    .filter((t): t is string => !!t && !t.includes("{"));
}

export function SkillsPage() {
  const platform = useMemo(detectPlatform, []);
  const [skills, setSkills] = useState<SkillSummaryResponse[] | null>(null);
  const [details, setDetails] = useState<Record<string, SkillResponse>>({});
  const [detailsFailed, setDetailsFailed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const ctx = useCallback(
    (): EventContext => ({ project_id: "standalone", platform, entry_point: "skills_page" }),
    [platform],
  );

  const fail = (e: unknown) => {
    const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
    setError(uiError(f.code, f.retryAfterSeconds));
  };
  const load = useCallback(async () => {
    setError(null);
    try {
      setSkills(await listSkills());
    } catch (e) {
      fail(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (s: SkillSummaryResponse) => {
    const next = open === s.id ? null : s.id;
    setOpen(next);
    if (next && !details[s.id]) {
      setDetailsFailed((m) => ({ ...m, [s.id]: false }));
      void getSkill(s.id)
        .then((d) => setDetails((m) => ({ ...m, [s.id]: d })))
        // The panel still works; say the age and caveats are missing rather than hide them.
        .catch(() => setDetailsFailed((m) => ({ ...m, [s.id]: true })));
    }
  };

  const remove = async (s: SkillSummaryResponse) => {
    if (!window.confirm(P.deleteSkillConfirm(s.name))) return;
    try {
      await deleteSkill(s.id);
      setSkills((list) => (list ?? []).filter((x) => x.id !== s.id));
      if (open === s.id) setOpen(null);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className={css.page}>
      <Nav current="skills" />
      <div>
        <h1 className={css.title}>{P.skillsTitle}</h1>
        <p className={css.muted}>{P.skillsIntro}</p>
      </div>
      {error && (
        <div className={css.error} role="alert">
          {error.message}
          <div className={css.actions}>
            <button type="button" className={css.btn} onClick={() => void load()}>
              {P.retry}
            </button>
          </div>
        </div>
      )}
      {skills === null && !error && (
        <div className={css.muted} role="status">
          {P.loadingSkills}
        </div>
      )}
      {skills && skills.length === 0 && (
        <div className={css.card}>
          <p>{P.skillsEmpty}</p>
          <div className={css.actions}>
            <a className={`${css.btn} ${css.primary}`} href="/playbooks">
              {P.navPlaybooks}
            </a>
          </div>
        </div>
      )}
      {skills && skills.length > 0 && (
        <div className={css.card} data-testid="skills">
          {skills.map((s) => {
            const panelId = `skill-${s.id}`;
            const detail = details[s.id];
            return (
              <div key={s.id} className={css.skill} data-testid="skill">
                <div className={css.skillHead}>
                  <h2 className={css.skillName}>{s.name}</h2>
                  <span className={css.muted}>{P.lastUsed(s.last_used_at)}</span>
                </div>
                <div className={css.muted}>{P.skillFrom(s.source.type, s.source.title)}</div>
                <div className={css.actions}>
                  <button
                    type="button"
                    className={`${css.btn} ${open === s.id ? "" : css.primary}`}
                    onClick={() => toggle(s)}
                    aria-expanded={open === s.id}
                    aria-controls={panelId}
                    aria-label={P.applySkillAria(s.name)}
                  >
                    {P.applySkill}
                  </button>
                  <button
                    type="button"
                    className={css.btn}
                    onClick={() => void remove(s)}
                    aria-label={P.deleteSkillAria(s.name)}
                  >
                    {P.deleteSkill}
                  </button>
                </div>
                {open === s.id && (
                  <>
                    {detail && (
                      <div className={css.muted} data-testid="skill-age">
                        {P.skillAge(detail.snapshot.generated_at)}
                      </div>
                    )}
                    {!detail && detailsFailed[s.id] && (
                      <div className={css.note} role="status">
                        {P.skillDetailsUnavailable}
                      </div>
                    )}
                    {caveats(detail).map((text) => (
                      <div key={text} className={css.note} data-testid="skill-caveat">
                        {text}
                      </div>
                    ))}
                    <ApplyPanel
                      idPrefix={panelId}
                      level={3}
                      apply={(body) => applySkill(s.id, body)}
                      onApplied={(r, body) => {
                        track("skill_applied", ctx(), {
                          skill_id: s.id,
                          source_type: s.source.type,
                          has_goal: Boolean(body.goal),
                          shots: r.shot_list.length,
                          cached: r.meta.cached,
                        });
                        setSkills((list) =>
                          (list ?? []).map((x) =>
                            x.id === s.id ? { ...x, last_used_at: new Date().toISOString() } : x,
                          ),
                        );
                      }}
                      onSendToDirector={() =>
                        track("prompt_sent_to_director", ctx(), { skill_id: s.id })
                      }
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
