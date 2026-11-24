/**
 * Match Cut as MCP tools (PRD-playbooks.md, Feature 1). The tools call the existing /v1 brief
 * routes, so validation, rate limits, caching, the spend cap and logging all apply unchanged.
 * Match Cut never calls Cardboard: the assistant hands the prompt to Cardboard's own connector.
 */
import {
  GOAL_MAX_CHARS,
  TARGET_FORMATS,
  TERMINAL_STATUSES,
  type BriefResponse,
} from "@match-cut/core";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

/** What the tools need from the API: the /v1/briefs routes, called in-process. */
export interface BriefsApi {
  create(body: Record<string, unknown>): Promise<ApiResult>;
  get(id: string): Promise<ApiResult>;
  regenerate(id: string, body: Record<string, unknown>): Promise<ApiResult>;
}
export interface ApiResult {
  status: number;
  body: unknown;
}

export interface McpToolOptions {
  /** How long a tool call waits for a running job before handing back the brief ID. */
  waitMs?: number;
  /** How often it checks on the job while waiting. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const MCP_INSTRUCTIONS = [
  "Match Cut studies a YouTube reference video (picture and sound) and writes an edit prompt for Cardboard, an AI video editor.",
  "Typical flow: call analyze_reference with the link and what the user is making; show the user the prompt; once they confirm, give the prompt to the Cardboard connector, if connected, to edit their own footage.",
  "Never start an edit without the user's confirmation.",
  "If a result says the analysis is still running, wait about 10 seconds and call get_brief with the brief_id.",
].join(" ");

const BRIEF_ID = z
  .string()
  .regex(/^brf_[0-9a-f]{32}$/, "a brief_id from analyze_reference")
  .describe("The brief_id returned by analyze_reference");

const format = z
  .enum(TARGET_FORMATS)
  .describe("Aspect ratio of the user's video; \"match\" keeps the reference's");
const lengthSeconds = z
  .number()
  .int()
  .min(5)
  .max(600)
  .describe("Target length of the user's video in seconds; omit to match the reference");

const briefOutput = z.object({
  brief_id: z.string(),
  status: z.enum(["queued", "processing", "succeeded", "partial", "failed", "cancelled"]),
  stage: z.string().nullable(),
  video: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      channel: z.string().nullable(),
      duration_seconds: z.number().nullable(),
    })
    .nullable(),
  cardboard_prompt: z.string().nullable(),
  hook: z.string().nullable(),
  beats: z.array(z.object({ start: z.string(), end: z.string(), label: z.string() })),
  assets_needed: z.array(z.string()),
  watch_outs: z.array(z.string()),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  next_step: z.string(),
});
type BriefOutput = z.infer<typeof briefOutput>;

const TERMINAL = new Set<string>(TERMINAL_STATUSES);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isBrief(body: unknown): body is BriefResponse {
  return typeof body === "object" && body !== null && "id" in body && "status" in body;
}

/** The API's own user-facing message, never raw upstream text. */
function errorResult(res: ApiResult) {
  const err = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
  const code = err?.code ?? "INTERNAL";
  const message = err?.message ?? "Something went wrong while analyzing.";
  return { isError: true, content: [{ type: "text" as const, text: `${message} (${code})` }] };
}

function nextStep(b: BriefResponse): string {
  switch (b.status) {
    case "succeeded":
      return "Show the user the prompt. After they confirm, pass it to the Cardboard connector to edit their footage.";
    case "partial":
      return "The breakdown is saved but the prompt wasn't written (the model was busy). Call regenerate_prompt with this brief_id.";
    case "queued":
    case "processing":
      return "Still analyzing. Wait about 10 seconds, then call get_brief with this brief_id.";
    default:
      return "This analysis did not finish. Tell the user why, using the message above.";
  }
}

export function toOutput(b: BriefResponse): BriefOutput {
  return {
    brief_id: b.id,
    status: b.status,
    stage: b.stage,
    video: b.video
      ? {
          id: b.video.id,
          title: b.video.title,
          channel: b.video.channel,
          duration_seconds: b.video.duration_seconds,
        }
      : null,
    cardboard_prompt: b.cardboard_prompt,
    hook: b.breakdown?.hook ?? null,
    beats: (b.breakdown?.beats ?? []).map((x) => ({ start: x.start, end: x.end, label: x.label })),
    assets_needed: b.assets_needed ?? [],
    watch_outs: b.watch_outs ?? [],
    warnings: b.warnings,
    next_step: nextStep(b),
  };
}

function mmss(seconds: number | null): string {
  if (seconds === null) return "unknown length";
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

/** Short, readable text for assistants that only show text; the same data is in structuredContent. */
export function toText(o: BriefOutput): string {
  const title = o.video?.title ? `"${o.video.title}"` : "the reference";
  const who = o.video?.channel ? ` by ${o.video.channel}` : "";
  const head = `${title}${who} (${mmss(o.video?.duration_seconds ?? null)}), brief_id ${o.brief_id}`;
  const lines: string[] = [];
  if (o.status === "succeeded" && o.cardboard_prompt) {
    lines.push(`Brief ready for ${head}.`, "", "Cardboard prompt:", o.cardboard_prompt);
    if (o.assets_needed.length) lines.push("", `Prepare first: ${o.assets_needed.join("; ")}`);
    if (o.watch_outs.length) lines.push(`Watch-outs: ${o.watch_outs.join("; ")}`);
  } else if (o.status === "partial") {
    lines.push(`Breakdown ready for ${head}, but the prompt wasn't written.`);
    if (o.hook) lines.push("", `Hook: ${o.hook}`);
  } else if (o.status === "queued" || o.status === "processing") {
    lines.push(`Analyzing ${head}${o.stage ? ` (stage: ${o.stage})` : ""}.`);
  } else {
    lines.push(`Analysis of ${head} ended with status ${o.status}.`);
  }
  for (const w of o.warnings) lines.push(`Note: ${w.message}`);
  lines.push("", `Next: ${o.next_step}`);
  return lines.join("\n");
}

function briefResult(b: BriefResponse) {
  if (b.status === "failed" || b.status === "cancelled") {
    const message = b.error?.message ?? "The analysis did not finish.";
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${message} (${b.error?.code ?? b.status})` }],
    };
  }
  const out = toOutput(b);
  return { content: [{ type: "text" as const, text: toText(out) }], structuredContent: out };
}

export function buildMcpServer(api: BriefsApi, opts: McpToolOptions = {}): McpServer {
  const waitMs = opts.waitMs ?? 45_000;
  const pollMs = opts.pollMs ?? 2_000;
  const sleep = opts.sleep ?? defaultSleep;

  /** Waits for a running job, up to waitMs, then returns whatever state it is in. */
  async function settle(first: BriefResponse): Promise<BriefResponse> {
    let b = first;
    const deadline = Date.now() + waitMs;
    while (!TERMINAL.has(b.status) && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      const res = await api.get(b.id);
      if (res.status !== 200 || !isBrief(res.body)) break;
      b = res.body;
    }
    return b;
  }

  const server = new McpServer(
    { name: "match-cut", version: "0.1.0" },
    { instructions: MCP_INSTRUCTIONS },
  );

  server.registerTool(
    "analyze_reference",
    {
      title: "Analyze a reference video",
      description:
        "Watch a public YouTube video (picture and sound) and write a ready-to-run Cardboard edit prompt that recreates its pacing, cuts, framing, captions and sound on the user's own footage. Returns the prompt, the reference's hook and beats, what to prepare, and what not to copy. Takes 15 to 90 seconds; if it isn't done within about 45 seconds this returns a brief_id to check with get_brief. Show the prompt to the user and get their confirmation before any edit runs.",
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .max(2048)
          .describe("YouTube link (watch, Shorts, youtu.be) or 11-character video ID"),
        goal: z
          .string()
          .max(GOAL_MAX_CHARS)
          .optional()
          .describe(
            "What the user is making, for example 'a 30-second launch video for my app'. Optional.",
          ),
        format: format.optional(),
        length_seconds: lengthSeconds.optional(),
        clip_start_seconds: z
          .number()
          .min(0)
          .optional()
          .describe("Analyze only part of a long video: start, in seconds"),
        clip_end_seconds: z
          .number()
          .positive()
          .optional()
          .describe("Analyze only part of a long video: end, in seconds"),
      }),
      outputSchema: briefOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const target: Record<string, unknown> = {};
      if (args.format) target.format = args.format;
      if (args.length_seconds !== undefined) target.length_seconds = args.length_seconds;
      const body: Record<string, unknown> = { source: { url: args.url }, target };
      if (args.goal) body.goal = args.goal;
      if (args.clip_start_seconds !== undefined || args.clip_end_seconds !== undefined) {
        body.clip = { start_seconds: args.clip_start_seconds, end_seconds: args.clip_end_seconds };
      }
      const res = await api.create(body);
      if ((res.status !== 200 && res.status !== 202) || !isBrief(res.body)) return errorResult(res);
      return briefResult(await settle(res.body));
    },
  );

  server.registerTool(
    "get_brief",
    {
      title: "Get a brief",
      description:
        "Check on an analysis started with analyze_reference, or fetch a finished brief again. Call it about every 10 seconds while the status is queued or processing.",
      inputSchema: z.object({ brief_id: BRIEF_ID }),
      outputSchema: briefOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ brief_id }) => {
      const res = await api.get(brief_id);
      if (res.status !== 200 || !isBrief(res.body)) return errorResult(res);
      return briefResult(await settle(res.body));
    },
  );

  server.registerTool(
    "regenerate_prompt",
    {
      title: "Rewrite the prompt",
      description:
        "Write a new Cardboard prompt from an existing brief for a different goal, format or length, without re-watching the video (a few seconds). Also use it when a brief came back with status partial.",
      inputSchema: z.object({
        brief_id: BRIEF_ID,
        goal: z.string().max(GOAL_MAX_CHARS).optional().describe("New goal; omit to keep it"),
        format: format.optional(),
        length_seconds: lengthSeconds.optional(),
      }),
      outputSchema: briefOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ brief_id, goal, format: fmt, length_seconds }) => {
      const body: Record<string, unknown> = {};
      if (goal !== undefined) body.goal = goal;
      const target: Record<string, unknown> = {};
      if (fmt) target.format = fmt;
      if (length_seconds !== undefined) target.length_seconds = length_seconds;
      if (Object.keys(target).length) body.target = target;
      const res = await api.regenerate(brief_id, body);
      if ((res.status !== 200 && res.status !== 202) || !isBrief(res.body)) return errorResult(res);
      return briefResult(await settle(res.body));
    },
  );

  return server;
}
