"use client";
/**
 * Skills list (PRD-playbooks.md, Frontend additions): name, source, last used, Apply. A skill
 * applies without re-watching anything, and keeps working after its playbook or brief is gone.
 */
import type { SkillSummaryResponse } from "@match-cut/core/playbooks/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { detectPlatform, track, type EventContext } from "../../lib/analytics";
import { ApiFailure } from "../../lib/api";
import { uiError, type UiError } from "../../lib/errors-ui";
import { applySkill, deleteSkill, listSkills } from "../../lib/playbook-api";
import { P } from "../../lib/playbook-strings";
import { ApplyPanel } from "./ApplyPanel";
import { Nav } from "./Nav";
import css from "./playbook.module.css";

export function SkillsPage() {
  const platform = useMemo(detectPlatform, []);
  const [skills, setSkills] = useState<SkillSummaryResponse[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const ctx = useCallback(
    (): EventContext => ({ project_id: "standalone", platform, entry_point: "skills_page" }),
    [platform],
  );

  const load = useCallback(async () => {
    try {
      setSkills(await listSkills());
      setError(null);
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
      setError(uiError(f.code, f.retryAfterSeconds));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (s: SkillSummaryResponse) => {
    if (!window.confirm(P.deleteSkillConfirm(s.name))) return;
    try {
      await deleteSkill(s.id);
      setSkills((list) => (list ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure("INTERNAL", 0);
      setError(uiError(f.code, f.retryAfterSeconds));
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
          {skills.map((s) => (
            <div key={s.id} className={css.skill} data-testid="skill">
              <div className={css.skillHead}>
                <span className={css.skillName}>{s.name}</span>
                <span className={css.muted}>{P.lastUsed(s.last_used_at)}</span>
              </div>
              <div className={css.muted}>{P.skillFrom(s.source.type, s.source.title)}</div>
              <div className={css.actions}>
                <button
                  type="button"
                  className={`${css.btn} ${open === s.id ? "" : css.primary}`}
                  onClick={() => setOpen(open === s.id ? null : s.id)}
                  aria-expanded={open === s.id}
                >
                  {P.applySkill}
                </button>
                <button type="button" className={css.btn} onClick={() => void remove(s)}>
                  {P.deleteSkill}
                </button>
              </div>
              {open === s.id && (
                <ApplyPanel
                  idPrefix={`skill-${s.id}`}
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
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
