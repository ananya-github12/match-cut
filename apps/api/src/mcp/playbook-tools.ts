/**
 * Playbook and skill tools for the Match Cut MCP server (PRD-playbooks.md, Features 3 and 4,
 * "MCP playbook tools" in the M10 scope). Like the brief tools, they call the /v1 routes
 * in-process, so validation, ownership, rate limits, refunds, caching and the spend cap apply.
 *
 * The evidence stays honest in every answer: rules are patterns the breakouts share, shown with
 * their counts ("4 of 5 breakouts · 1 of 5 typical"), next to what the edit doesn't explain.
 */
import {
  GOAL_MAX_CHARS,
  NOT_ENOUGH_DATA_REASON_COPY,
  PLAYBOOK_COPY,
  TARGET_FORMATS,
  TERMINAL_STATUSES,
  type ApplyResponse,
  type PlaybookResponse,
  type PlaybookRule,
  type SkillResponse,
  type SkillSummaryResponse,
} from "@match-cut/core";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { ApiResult } from "./tools.js";

/** The /v1 playbook and skill routes, called in-process as the key's user. */
export interface PlaybooksApi {
  createPlaybook(body: Record<string, unknown>): Promise<ApiResult>;
  getPlaybook(id: string): Promise<ApiResult>;
  applyPlaybook(id: string, body: Record<string, unknown>): Promise<ApiResult>;
  saveSkill(body: Record<string, unknown>): Promise<ApiResult>;
  listSkills(): Promise<ApiResult>;
  applySkill(id: string, body: Record<string, unknown>): Promise<ApiResult>;
}

export interface SettleOptions {
  waitMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

const TERMINAL = new Set<string>(TERMINAL_STATUSES);
const DEFAULT_NOT_EXPLAINED = PLAYBOOK_COPY.DEFAULT_NOT_EXPLAINED;

const PLAYBOOK_ID = z
  .string()
  .regex(/^pbk_[0-9a-f]{32}$/, "a playbook_id from build_playbook")
  .describe("The playbook_id returned by build_playbook");
const SKILL_ID = z
  .string()
  .regex(/^skl_[0-9a-f]{32}$/, "a skill_id from save_skill or list_skills")
  .describe("The skill_id returned by save_skill or list_skills");

/** What to make: the same fields for apply_playbook and apply_skill. */
const applyArgs = {
  goal: z
    .string()
    .max(GOAL_MAX_CHARS)
    .optional()
    .describe("What the user is making, for example 'a 30-second video about my coffee cart'"),
  format: z
    .enum(TARGET_FORMATS)
    .optional()
    .describe('Aspect ratio of the user\'s video; "match" means vertical 9:16, like Shorts'),
  length_seconds: z
    .number()
    .int()
    .min(5)
    .max(600)
    .optional()
    .describe("Target length in seconds; omit for a typical Short"),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .optional()
    .describe('BCP-47 language for the prompt, for example "en" or "pt-BR"; default "en"'),
};

const ruleOut = z.object({
  title: z.string(),
  how_to: z.string(),
  confidence: z.enum(["high", "medium"]),
  /** "4 of 5 breakouts · 1 of 5 typical": computed counts, never model-written. */
  evidence: z.string(),
  examples: z.array(z.object({ video_id: z.string(), timestamp: z.string() })),
  counterexample: z.string().nullable(),
});

const playbookOutput = z.object({
  playbook_id: z.string(),
  status: z.enum(["queued", "processing", "succeeded", "partial", "failed", "cancelled"]),
  stage: z.string().nullable(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  channel: z
    .object({ id: z.string(), title: z.string(), handle: z.string().nullable() })
    .nullable(),
  shorts_compared: z.number().nullable(),
  breakouts: z.array(
    z.object({
      video_id: z.string(),
      title: z.string(),
      views: z.number(),
      outlier_score: z.number().nullable(),
    }),
  ),
  rules: z.array(ruleOut),
  baseline_median_views: z.number().nullable(),
  house_style: z.string().nullable(),
  not_explained: z.array(z.string()),
  recipe_prompt_template: z.string().nullable(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  next_step: z.string(),
});
type PlaybookOutput = z.infer<typeof playbookOutput>;

const shotOut = z.object({
  shot: z.string(),
  framing: z.string(),
  duration_seconds: z.number(),
  maps_to_beat: z.number(),
  notes: z.string(),
});

const applyOutput = z.object({
  source: z.object({ type: z.enum(["playbook", "skill"]), id: z.string() }),
  cardboard_prompt: z.string(),
  assets_needed: z.array(z.string()),
  watch_outs: z.array(z.string()),
  shot_list: z.array(shotOut),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  next_step: z.string(),
});
type ApplyOutput = z.infer<typeof applyOutput>;

const skillOut = z.object({
  skill_id: z.string(),
  name: z.string(),
  source: z.object({
    type: z.enum(["brief", "playbook"]),
    id: z.string(),
    title: z.string().nullable(),
  }),
  last_used_at: z.string().nullable(),
});

function isPlaybook(body: unknown): body is PlaybookResponse {
  return typeof body === "object" && body !== null && "id" in body && "videos" in body;
}

function errorResult(res: ApiResult) {
  const err = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
  const code = err?.code ?? "INTERNAL";
  const message = err?.message ?? "Something went wrong.";
  return { isError: true, content: [{ type: "text" as const, text: `${message} (${code})` }] };
}

/** The PRD's evidence wording: "4 of 5 breakouts · 1 of 5 typical". Counts come from code. */
export const evidenceText = (r: PlaybookRule) =>
  `${r.evidence.outliers_with} of ${r.evidence.outliers_known} breakouts · ${r.evidence.typical_with} of ${r.evidence.typical_known} typical`;

function playbookNextStep(p: PlaybookResponse): string {
  if (p.status === "queued" || p.status === "processing") {
    return "Still analyzing the channel (it watches up to 10 Shorts). Wait about 30 seconds, then call get_playbook with this playbook_id.";
  }
  if (p.status !== "succeeded") {
    return "This playbook did not finish. Tell the user why, using the message above.";
  }
  if (!p.rules?.length) {
    return "No edit pattern sets this channel's breakouts apart, so there's nothing to apply. Tell the user, with what the edit doesn't explain.";
  }
  return "Show the user each rule with its evidence counts, and what the edit doesn't explain: these are patterns the breakouts share, not proof of what caused them. To use the playbook, ask the user what they're making and call apply_playbook with that goal (it returns the prompt and the shots to film); save_skill keeps it for later.";
}

export function toPlaybookOutput(p: PlaybookResponse): PlaybookOutput {
  return {
    playbook_id: p.id,
    status: p.status,
    stage: p.stage,
    progress: p.progress,
    channel: p.channel && {
      id: p.channel.id,
      title: plainThirdParty(p.channel.title),
      handle: p.channel.handle,
    },
    shorts_compared: p.status === "succeeded" ? p.videos.filter((v) => v.compared).length : null,
    breakouts: p.videos
      .filter((v) => v.group === "outlier" && v.compared)
      .map((v) => ({
        video_id: v.id,
        title: plainThirdParty(v.title),
        views: v.views,
        outlier_score: v.outlier_score,
      })),
    rules: (p.rules ?? []).map((r) => ({
      title: r.title,
      how_to: r.how_to,
      confidence: r.confidence,
      evidence: evidenceText(r),
      examples: r.examples,
      counterexample: r.counterexample,
    })),
    baseline_median_views: p.baseline?.median_views ?? null,
    house_style: p.house_style,
    not_explained: p.not_explained ?? [],
    recipe_prompt_template: p.recipe_prompt_template,
    warnings: p.warnings,
    next_step: playbookNextStep(p),
  };
}

const at = (ts: string) => ts.replace(/^0(\d:)/, "$1");

/**
 * Owner-written text (channel and video titles, skill names) for an assistant: control
 * characters and line breaks removed, and capped. Used as is in structuredContent, which most
 * clients also hand to the model.
 */
export function plainThirdParty(text: string, max = 100): string {
  const clean = text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...clean].length > max ? `${[...clean].slice(0, max - 1).join("")}…` : clean;
}

/** The same, quoted for text output, so it reads as data, not instructions. */
export const thirdParty = (text: string, max = 100): string =>
  JSON.stringify(plainThirdParty(text, max));

const plainOrNull = (text: string | null, max?: number) =>
  text === null ? null : plainThirdParty(text, max);

const views = (n: number) => n.toLocaleString("en-US");

/** Readable text for assistants that only show text; the same data is in structuredContent. */
export function playbookText(o: PlaybookOutput): string {
  const who = o.channel
    ? `${thirdParty(o.channel.title)}${o.channel.handle ? ` (@${o.channel.handle})` : ""}`
    : "the channel";
  // Breakouts are numbered B1, B2 ... so examples and counterexamples read without IDs alone.
  const label = new Map(o.breakouts.map((b, i) => [b.video_id, `B${i + 1}`]));
  const ref = (id: string) => label.get(id) ?? id;
  const lines: string[] = [];
  if (o.status === "queued" || o.status === "processing") {
    const prog = o.progress ? `, watched ${o.progress.done} of ${o.progress.total}` : "";
    lines.push(
      `Analyzing ${who}${o.stage ? ` (stage: ${o.stage}${prog})` : ""}, playbook_id ${o.playbook_id}.`,
    );
  } else if (o.status === "succeeded") {
    lines.push(
      `Playbook for ${who}, playbook_id ${o.playbook_id}. ${o.breakouts.length} breakout Shorts compared with the channel's typical ones (${o.shorts_compared} compared in all${o.baseline_median_views !== null ? `; the channel's median is ${views(o.baseline_median_views)} views` : ""}).`,
    );
    if (o.breakouts.length) {
      lines.push("", "Breakouts (titles are the creator's, shown as data):");
      o.breakouts.forEach((b, i) =>
        lines.push(
          `B${i + 1}. ${thirdParty(b.title)} (${b.video_id}): ${views(b.views)} views${b.outlier_score !== null ? `, ${b.outlier_score.toFixed(1)}x the median` : ""}`,
        ),
      );
    }
    if (o.rules.length) {
      lines.push("", "What the breakouts share (patterns, not proof of cause):");
      o.rules.forEach((r, i) => {
        const ex = r.examples.length
          ? ` Example: ${r.examples.map((e) => `${ref(e.video_id)} at ${at(e.timestamp)}`).join(", ")}.`
          : "";
        const ce = r.counterexample
          ? ` Counterexample: ${ref(r.counterexample)} does it differently.`
          : "";
        lines.push(`${i + 1}. ${r.title} (${r.confidence}; ${r.evidence}). ${r.how_to}${ex}${ce}`);
      });
    } else {
      lines.push("", "No edit pattern sets the breakouts apart from the typical Shorts.");
    }
    if (o.house_style) lines.push("", `House style: ${o.house_style}`);
    // Always shown (PRD): the counterweight to reading the rules as cause.
    const notExplained = o.not_explained.length ? o.not_explained : [DEFAULT_NOT_EXPLAINED];
    lines.push("", "What the edit doesn't explain:", ...notExplained.map((x) => `- ${x}`));
  } else {
    lines.push(`The playbook for ${who} ended with status ${o.status}.`);
  }
  for (const w of o.warnings) lines.push(`Note: ${w.message}`);
  lines.push("", `Next: ${o.next_step}`);
  return lines.join("\n");
}

/** The web app's words for each reason, lowercased to sit mid-sentence. */
const REASONS: Record<string, string> = Object.fromEntries(
  Object.entries(NOT_ENOUGH_DATA_REASON_COPY).map(([k, v]) => [
    k,
    v[0]!.toLowerCase() + v.slice(1),
  ]),
);

function playbookResult(p: PlaybookResponse) {
  if (p.status === "failed" || p.status === "cancelled") {
    const message =
      p.status === "cancelled"
        ? "This playbook was cancelled."
        : (p.error?.message ?? "The playbook did not finish.");
    const n = p.not_enough_data;
    const reasons = n
      ? ` Why: ${n.reasons.map((r) => REASONS[r] ?? r).join(", ")}. Found ${n.found.shorts_eligible} eligible Shorts, ${n.found.outliers} breakouts and ${n.found.typical} typical ones; a playbook needs at least ${n.minimums.shorts_eligible}, ${n.minimums.outliers} and ${n.minimums.typical}.`
      : "";
    const retry =
      p.status === "failed" && p.error?.retryable
        ? " This can be tried again in a few minutes."
        : " Trying again with the same input won't help.";
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `${message}${reasons}${retry} (${p.error?.code ?? p.status})`,
        },
      ],
    };
  }
  const out = toPlaybookOutput(p);
  return { content: [{ type: "text" as const, text: playbookText(out) }], structuredContent: out };
}

function applyBody(a: {
  goal?: string;
  format?: string;
  length_seconds?: number;
  language?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (a.goal !== undefined) body.goal = a.goal;
  const target: Record<string, unknown> = {};
  if (a.format) target.format = a.format;
  if (a.length_seconds !== undefined) target.length_seconds = a.length_seconds;
  if (Object.keys(target).length) body.target = target;
  if (a.language) body.output_language = a.language;
  return body;
}

export { applyBody };

export function applyText(o: ApplyOutput): string {
  const lines = ["Cardboard prompt:", o.cardboard_prompt];
  if (o.assets_needed.length) lines.push("", `Prepare first: ${o.assets_needed.join("; ")}`);
  if (o.watch_outs.length) lines.push(`Watch-outs: ${o.watch_outs.join("; ")}`);
  if (o.shot_list.length) {
    lines.push("", `What to film (${o.shot_list.length} shots):`);
    o.shot_list.forEach((s, i) =>
      lines.push(`${i + 1}. ${s.shot}. Framing: ${s.framing}. About ${s.duration_seconds} s.`),
    );
  }
  for (const w of o.warnings) lines.push(`Note: ${w.message}`);
  lines.push("", `Next: ${o.next_step}`);
  return lines.join("\n");
}

function applyResult(res: ApiResult, source: ApplyOutput["source"]) {
  if (res.status !== 200) return errorResult(res);
  const a = res.body as ApplyResponse;
  const out: ApplyOutput = {
    source,
    cardboard_prompt: a.cardboard_prompt,
    assets_needed: a.assets_needed,
    watch_outs: a.watch_outs,
    shot_list: a.shot_list,
    warnings: a.warnings,
    next_step:
      "Show the user the prompt and the shots to film. After they confirm, pass the prompt to the Cardboard connector to edit their footage.",
  };
  return { content: [{ type: "text" as const, text: applyText(out) }], structuredContent: out };
}

/** Exactly one of playbook_id and skill_id: the thing to apply. */
export function applySource(
  playbookId: string | undefined,
  skillId: string | undefined,
): { type: "playbook" | "skill"; id: string } | null {
  if ((playbookId === undefined) === (skillId === undefined)) return null;
  return playbookId ? { type: "playbook", id: playbookId } : { type: "skill", id: skillId! };
}

export function applyVia(
  api: PlaybooksApi,
  source: { type: "playbook" | "skill"; id: string },
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return source.type === "playbook"
    ? api.applyPlaybook(source.id, body)
    : api.applySkill(source.id, body);
}

/** A tool needs exactly one of these IDs. */
export const exactlyOne = (what: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: `Give exactly one of ${what}.` }],
});

const toSkillOut = (s: SkillSummaryResponse): z.infer<typeof skillOut> => ({
  skill_id: s.id,
  name: plainThirdParty(s.name, 80),
  source: { ...s.source, title: plainOrNull(s.source.title) },
  last_used_at: s.last_used_at,
});

export function registerPlaybookTools(server: McpServer, api: PlaybooksApi, o: SettleOptions) {
  /** Waits for a running playbook, up to waitMs, then returns whatever state it is in. */
  /**
   * Waits for a running playbook, up to waitMs, then returns its result. A failed check is
   * returned as that error, not as stale "still working" state the assistant would poll forever.
   */
  async function settled(first: PlaybookResponse) {
    let p = first;
    const deadline = Date.now() + o.waitMs;
    while (!TERMINAL.has(p.status) && Date.now() < deadline) {
      await o.sleep(Math.min(o.pollMs, Math.max(0, deadline - Date.now())));
      const res = await api.getPlaybook(p.id);
      if (res.status !== 200 || !isPlaybook(res.body)) return errorResult(res);
      p = res.body;
    }
    return playbookResult(p);
  }

  server.registerTool(
    "build_playbook",
    {
      title: "Find what a channel's breakout Shorts do",
      description:
        "Compare a YouTube channel's breakout Shorts (2x or more its median views) with its typical ones and list the edit choices the breakouts share, with evidence counts, what the edit doesn't explain, and a recipe. Uses public data only. Takes a few minutes; if it isn't done within about 45 seconds this returns a playbook_id to check with get_playbook about every 30 seconds. Present rules as patterns the breakouts share, not as proof of what made them work. New playbooks have a small daily limit per user (5 by default), and a channel that can't be found still counts, so confirm the handle with the user first. Asking again for the same channel and settings within 24 hours usually returns the finished playbook without using the limit.",
      inputSchema: z.object({
        channel: z
          .string()
          .min(1)
          .max(2048)
          .describe("A channel handle (@name), a channel URL, or any video URL from the channel"),
        window_days: z
          .number()
          .int()
          .min(30)
          .max(180)
          .optional()
          .describe("How far back to look, in days; default 90"),
        max_videos: z
          .number()
          .int()
          .min(10)
          .max(50)
          .optional()
          .describe("How many recent uploads to consider; default 50"),
      }),
      outputSchema: playbookOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const body: Record<string, unknown> = { source: { channel: args.channel } };
      if (args.window_days !== undefined) body.window_days = args.window_days;
      if (args.max_videos !== undefined) body.max_videos = args.max_videos;
      const res = await api.createPlaybook(body);
      if ((res.status !== 200 && res.status !== 202) || !isPlaybook(res.body)) {
        return errorResult(res);
      }
      return settled(res.body);
    },
  );

  server.registerTool(
    "get_playbook",
    {
      title: "Get a playbook",
      description:
        "Check on a playbook started with build_playbook, or fetch a finished one again. Call it about every 30 seconds while the status is queued or processing.",
      inputSchema: z.object({ playbook_id: PLAYBOOK_ID }),
      outputSchema: playbookOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ playbook_id }) => {
      const res = await api.getPlaybook(playbook_id);
      if (res.status !== 200 || !isPlaybook(res.body)) return errorResult(res);
      return settled(res.body);
    },
  );

  server.registerTool(
    "apply_playbook",
    {
      title: "Use a playbook or saved skill for the user's video",
      description:
        "Turn a finished playbook (playbook_id) or a saved skill (skill_id) into a Cardboard edit prompt and a list of shots to film. Ask the user what they're making first and pass it as goal; without one the prompt stays generic. A few seconds; never re-watches video. Show the user the whole prompt and get their confirmation before it goes to Cardboard or any edit runs.",
      inputSchema: z.object({
        playbook_id: PLAYBOOK_ID.optional().describe(
          "A playbook from build_playbook; give either playbook_id or skill_id",
        ),
        skill_id: SKILL_ID.optional().describe(
          "A skill from save_skill or list_skills; give either playbook_id or skill_id",
        ),
        ...applyArgs,
      }),
      outputSchema: applyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ playbook_id, skill_id, ...rest }) => {
      const source = applySource(playbook_id, skill_id);
      if (!source) return exactlyOne("playbook_id or skill_id");
      return applyResult(await applyVia(api, source, applyBody(rest)), source);
    },
  );

  server.registerTool(
    "save_skill",
    {
      title: "Save as a skill",
      description:
        "Save a finished brief (from analyze_reference) or playbook (from build_playbook) as a named skill, so it can be applied to new videos later with apply_playbook, even after the original expires. Up to 50 skills per user.",
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe("A short name the user chooses or agrees to"),
        brief_id: z
          .string()
          .regex(/^brf_[0-9a-f]{32}$/)
          .optional()
          .describe("Save this brief; give either brief_id or playbook_id"),
        playbook_id: PLAYBOOK_ID.optional().describe(
          "Save this playbook; give either brief_id or playbook_id",
        ),
      }),
      outputSchema: skillOut.extend({ next_step: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, brief_id, playbook_id }) => {
      if ((brief_id === undefined) === (playbook_id === undefined)) {
        return exactlyOne("brief_id or playbook_id");
      }
      const res = await api.saveSkill({
        name,
        source: brief_id ? { brief_id } : { playbook_id },
      });
      if (res.status !== 201) return errorResult(res);
      const s = res.body as SkillResponse;
      const out = {
        ...toSkillOut(s),
        next_step:
          "Saved. To use it, ask the user what they're making and call apply_playbook with this skill_id and that goal.",
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved ${thirdParty(out.name, 80)} as skill ${out.skill_id}.\n\nNext: ${out.next_step}`,
          },
        ],
        structuredContent: out,
      };
    },
  );

  server.registerTool(
    "list_skills",
    {
      title: "List saved skills",
      description: "The user's saved skills, most recently used first.",
      inputSchema: z.object({}),
      outputSchema: z.object({ skills: z.array(skillOut) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const res = await api.listSkills();
      if (res.status !== 200) return errorResult(res);
      const skills = (res.body as { skills: SkillSummaryResponse[] }).skills.map(toSkillOut);
      const text = skills.length
        ? skills
            .map(
              (s, i) =>
                `${i + 1}. ${thirdParty(s.name, 80)} (skill_id ${s.skill_id}; from a ${s.source.type}${s.source.title ? `: ${thirdParty(s.source.title)}` : ""})`,
            )
            .join("\n")
        : "No saved skills yet. Save a brief or playbook with save_skill.";
      return { content: [{ type: "text" as const, text }], structuredContent: { skills } };
    },
  );
}
