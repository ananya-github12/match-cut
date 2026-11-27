/**
 * Saved skills. PRD-playbooks.md, Feature 4 and "API additions".
 *   POST   /v1/skills            save a brief's breakdown or a playbook's rules; 201
 *   GET    /v1/skills            the user's skills, most recently used first
 *   GET    /v1/skills/{id}       one skill with its snapshot
 *   DELETE /v1/skills/{id}       204
 *   POST   /v1/skills/{id}/apply prompt and shot list from the skill; 200
 * Applying a skill runs only the text step; it never re-watches video, and works after its
 * source brief or playbook is gone (the snapshot holds what it needs).
 */
import { randomUUID } from "node:crypto";
import { createSkillRequestSchema, MatchCutError, SKILLS_PER_USER } from "@match-cut/core";
import {
  skillFromBrief,
  skillFromPlaybook,
  toSkillResponse,
  toSkillSummary,
  type BriefStore,
  type PlaybookStore,
  type SkillRecord,
  type SkillStore,
} from "@match-cut/infra";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { runApply, type ApplyDeps } from "../apply.js";
import {
  abortOnDisconnect,
  assertApplicable,
  loadOwnedPlaybook,
  parseApplyBody,
  takeSlot,
} from "./playbooks.js";

export interface SkillsRouteDeps extends ApplyDeps {
  skills: SkillStore;
  briefs: BriefStore;
  playbooks: PlaybookStore;
  authenticate: (req: FastifyRequest) => Promise<void>;
  now?: () => number;
}

const newSkillId = () => `skl_${randomUUID().replace(/-/g, "")}`;

async function loadOwnedSkill(store: SkillStore, id: string, userId: string) {
  const s = await store.get(id);
  if (!s || s.userId !== userId) throw new MatchCutError("SKILL_NOT_FOUND");
  return s;
}

export async function skillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps) {
  const now = deps.now ?? Date.now;
  const auth = { preHandler: deps.authenticate };

  app.post("/v1/skills", auth, async (req, reply) => {
    const { userId, orgId } = req.auth;
    const parsed = createSkillRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new MatchCutError("INVALID_REQUEST");
    const { name, source } = parsed.data;

    let draft;
    let sourceRef: SkillRecord["source"];
    if ("brief_id" in source) {
      const brief = await deps.briefs.get(source.brief_id);
      if (!brief || brief.userId !== userId) throw new MatchCutError("BRIEF_NOT_FOUND");
      draft = skillFromBrief(brief);
      if (draft === "NOT_READY") throw new MatchCutError("BRIEF_NOT_READY");
      sourceRef = { type: "brief", id: brief.id };
    } else {
      const pb = await loadOwnedPlaybook(deps.playbooks, source.playbook_id, userId);
      assertApplicable(pb);
      draft = skillFromPlaybook(pb);
      sourceRef = { type: "playbook", id: pb.id };
    }
    if (typeof draft === "string") throw new MatchCutError("INTERNAL");

    const at = new Date(now());
    const record: SkillRecord = {
      id: newSkillId(),
      userId,
      orgId,
      name,
      source: sourceRef,
      sourceTitle: draft.sourceTitle,
      snapshot: draft.snapshot,
      versions: draft.versions,
      lastUsedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    if (!(await deps.skills.create(record, SKILLS_PER_USER))) {
      throw new MatchCutError("SKILL_LIMIT_REACHED", { limit: SKILLS_PER_USER });
    }
    return reply.status(201).send(toSkillResponse(record));
  });

  app.get("/v1/skills", auth, async (req) => {
    const list = await deps.skills.listByUser(req.auth.userId);
    return { skills: list.map(toSkillSummary) };
  });

  app.get<{ Params: { id: string } }>("/v1/skills/:id", auth, async (req) => {
    return toSkillResponse(await loadOwnedSkill(deps.skills, req.params.id, req.auth.userId));
  });

  app.delete<{ Params: { id: string } }>("/v1/skills/:id", auth, async (req, reply) => {
    const skill = await loadOwnedSkill(deps.skills, req.params.id, req.auth.userId);
    await deps.skills.delete(skill.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/skills/:id/apply", auth, async (req, reply) => {
    const skill = await loadOwnedSkill(deps.skills, req.params.id, req.auth.userId);
    const slotAt = await takeSlot(deps.limiter, "regenerate", req.auth);
    const body = parseApplyBody(req.body);
    const s = skill.snapshot;
    const result = await runApply(
      deps,
      req.auth,
      slotAt,
      s.type === "brief"
        ? { type: "breakdown", breakdown: s.breakdown }
        : {
            type: "recipe",
            recipe: {
              rules: s.rules.map((r) => ({
                feature: r.feature,
                value: r.value,
                title: r.title,
                how_to: r.how_to,
              })),
              houseStyle: s.houseStyle,
              template: s.recipePromptTemplate,
            },
          },
      body,
      // The source's speech isn't kept, only its fingerprints.
      { spokenLines: [], spokenFingerprints: s.spokenFingerprints },
      abortOnDisconnect(reply),
    );
    await deps.skills.markUsed(skill.id, new Date(now()));
    return reply.status(200).send(result);
  });
}
