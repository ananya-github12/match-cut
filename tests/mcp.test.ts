/**
 * M9: the Match Cut MCP server, driven by the official MCP client over real HTTP, in mock mode.
 * PRD-playbooks.md, Feature 1.
 */
import {
  MOCK_FAULT_IDS,
  MOCK_VIDEOS,
  MockAnalyzer,
  type CallContext,
  type ModelResult,
  type VideoAnalyzer,
  type WritePromptInput,
} from "@match-cut/providers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);
const SHORT = `https://youtube.com/shorts/${MOCK_VIDEOS.short.id}`;

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** API listening on a random port, with the MCP server on. */
async function server(opts: { autoRun?: boolean; keys?: string[]; analyzer?: VideoAnalyzer } = {}) {
  const h = harness({
    autoRun: opts.autoRun ?? true,
    analyzer: opts.analyzer,
    app: { mcp: { keys: opts.keys ?? [KEY_A, KEY_B], waitMs: 3000, pollMs: 20 } },
  });
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  open.push(h.app);
  const address = h.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { h, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

async function connect(url: URL, key = KEY_A) {
  const client = new Client({ name: "match-cut-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  open.push(client);
  return client;
}

type Structured = {
  brief_id: string;
  status: string;
  cardboard_prompt: string | null;
  beats: unknown[];
  next_step: string;
};
const text = (r: { content?: unknown }) =>
  ((r.content as { type: string; text: string }[] | undefined) ?? []).map((c) => c.text).join("\n");

describe("Match Cut MCP server", () => {
  it("lists the brief tools with schemas and server instructions", async () => {
    const { url } = await server();
    const client = await connect(url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "analyze_reference",
      "get_brief",
      "regenerate_prompt",
      "shot_list",
    ]);
    const analyze = tools.find((t) => t.name === "analyze_reference")!;
    expect(analyze.inputSchema.required).toEqual(["url"]);
    expect(analyze.outputSchema).toBeDefined();
    expect(analyze.description).toMatch(/confirmation/);
    expect(client.getInstructions()).toMatch(/Never start an edit without the user's confirmation/);
  });

  it("analyze_reference returns a finished brief: prompt in text and structured content", async () => {
    const { url } = await server();
    const client = await connect(url);
    const res = await client.callTool({
      name: "analyze_reference",
      arguments: { url: SHORT, goal: "A launch video for my app", format: "9:16" },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Structured;
    expect(out.status).toBe("succeeded");
    expect(out.brief_id).toMatch(/^brf_[0-9a-f]{32}$/);
    expect(out.cardboard_prompt).toMatch(/^1\. /m);
    expect(out.beats.length).toBeGreaterThan(1);
    expect(text(res)).toContain("Cardboard prompt:");
    expect(text(res)).toContain(out.cardboard_prompt!);
    expect(out.next_step).toMatch(/confirm/);
  });

  it("a job that outlasts the wait returns the brief_id; get_brief fetches it once done", async () => {
    const { h, url } = await server({ autoRun: false });
    const client = await connect(url);
    const first = await client.callTool({ name: "analyze_reference", arguments: { url: SHORT } });
    const queued = first.structuredContent as Structured;
    expect(queued.status).toBe("queued");
    expect(queued.next_step).toMatch(/get_brief/);
    expect(text(first)).toContain(queued.brief_id);

    await h.drain();
    const later = await client.callTool({
      name: "get_brief",
      arguments: { brief_id: queued.brief_id },
    });
    expect((later.structuredContent as Structured).status).toBe("succeeded");
  });

  it("a partial brief points to regenerate_prompt, which writes the prompt", async () => {
    const { url } = await server();
    const client = await connect(url);
    const res = await client.callTool({
      name: "analyze_reference",
      arguments: { url: SHORT, goal: `Launch video ${MOCK_FAULT_IDS.pass2Fails}` },
    });
    const partial = res.structuredContent as Structured;
    expect(partial.status).toBe("partial");
    expect(partial.cardboard_prompt).toBeNull();
    expect(partial.next_step).toMatch(/regenerate_prompt/);

    const fixed = await client.callTool({
      name: "regenerate_prompt",
      arguments: { brief_id: partial.brief_id, goal: "A launch video for my app" },
    });
    const out = fixed.structuredContent as Structured;
    expect(out.status).toBe("succeeded");
    expect(out.cardboard_prompt).toMatch(/^1\. /m);
  });

  it("API errors come back as tool errors with the user-facing message", async () => {
    const { url } = await server();
    const client = await connect(url);
    const bad = await client.callTool({
      name: "analyze_reference",
      arguments: { url: "https://vimeo.com/123" },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/UNSUPPORTED_SOURCE/);

    const priv = await client.callTool({
      name: "analyze_reference",
      arguments: { url: `https://youtu.be/${MOCK_VIDEOS.private.id}` },
    });
    expect(priv.isError).toBe(true);
    expect(text(priv)).toMatch(/VIDEO_NOT_PUBLIC/);
  });

  it("each key is its own user: briefs aren't visible across keys", async () => {
    const { url } = await server();
    const a = await connect(url, KEY_A);
    const b = await connect(url, KEY_B);
    const res = await a.callTool({ name: "analyze_reference", arguments: { url: SHORT } });
    const id = (res.structuredContent as Structured).brief_id;
    const other = await b.callTool({ name: "get_brief", arguments: { brief_id: id } });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/NOT_FOUND/);
  });

  it("rejects a malformed brief_id before calling the API", async () => {
    const { url } = await server();
    const client = await connect(url);
    const res = await client.callTool({ name: "get_brief", arguments: { brief_id: "../v1/x" } });
    expect(res.isError).toBe(true);
  });
});

describe("MCP endpoint access", () => {
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "curl", version: "1" },
    },
  };
  const accept = { accept: "application/json, text/event-stream" };

  it("401 without a key or with a wrong key", async () => {
    const { h } = await server();
    const none = await h.app.inject({
      method: "POST",
      url: "/mcp",
      payload: init,
      headers: accept,
    });
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toMatch(/Bearer/);
    const wrong = await h.app.inject({
      method: "POST",
      url: "/mcp",
      payload: init,
      headers: { ...accept, authorization: `Bearer ${"c".repeat(32)}` },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("the dev API token alone doesn't open the MCP server", async () => {
    const { h } = await server();
    const res = await h.app.inject({
      method: "POST",
      url: "/mcp",
      payload: init,
      headers: { ...accept, authorization: "Bearer test-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 when no keys are configured", async () => {
    const { h } = await server({ keys: [] });
    const res = await h.app.inject({
      method: "POST",
      url: "/mcp",
      payload: init,
      headers: { ...accept, authorization: `Bearer ${KEY_A}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET and DELETE are 405 (stateless server)", async () => {
    const { h } = await server();
    for (const method of ["GET", "DELETE"] as const) {
      const res = await h.app.inject({ method, url: "/mcp" });
      expect(res.statusCode).toBe(405);
    }
  });
});

/** Mock that writes a too-short shot list (dropped by validation) while `broken` is true. */
class SwitchableShots extends MockAnalyzer {
  broken = true;
  override async writePrompt(
    input: WritePromptInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult> {
    const res = await super.writePrompt(input, signal, ctx);
    if (!this.broken) return res;
    const output = res.output as { shot_list: unknown[] };
    const bad = { ...output, shot_list: output.shot_list.slice(0, 2) };
    return { ...res, output: bad, text: JSON.stringify(bad) };
  }
}

type ShotsOut = {
  brief_id: string;
  status: string;
  shot_list: { maps_to_beat: number; duration_seconds: number }[];
  total_seconds: number | null;
  next_step: string;
};

describe("shot_list tool", () => {
  it("briefs mention the shot list; shot_list returns it in edit order with totals", async () => {
    const { url } = await server();
    const client = await connect(url);
    const res = await client.callTool({ name: "analyze_reference", arguments: { url: SHORT } });
    expect(text(res)).toMatch(/Shot list: \d+ shots to film/);
    const id = (res.structuredContent as Structured).brief_id;

    const shots = await client.callTool({ name: "shot_list", arguments: { brief_id: id } });
    expect(shots.isError).toBeFalsy();
    const out = shots.structuredContent as ShotsOut;
    expect(out.shot_list.length).toBeGreaterThanOrEqual(4);
    expect(out.total_seconds).toBeCloseTo(45, 0);
    expect(text(shots)).toMatch(/^1\. \[beat 1, /m);
    expect(text(shots)).toMatch(/Framing: /);
  });

  it("a new length plans shots for the new video", async () => {
    const { url } = await server();
    const client = await connect(url);
    const res = await client.callTool({ name: "analyze_reference", arguments: { url: SHORT } });
    const id = (res.structuredContent as Structured).brief_id;
    const shots = await client.callTool({
      name: "shot_list",
      arguments: { brief_id: id, length_seconds: 20 },
    });
    expect((shots.structuredContent as ShotsOut).total_seconds).toBeCloseTo(20, 0);
  });

  it("a brief whose shot list was dropped gets a new one, without re-watching", async () => {
    const analyzer = new SwitchableShots();
    const { url } = await server({ analyzer });
    const client = await connect(url);
    const res = await client.callTool({ name: "analyze_reference", arguments: { url: SHORT } });
    const brief = res.structuredContent as Structured & { shot_list: unknown[] };
    expect(brief.status).toBe("succeeded");
    expect(brief.shot_list).toEqual([]);
    expect(text(res)).toMatch(/couldn't build a shot list/);

    analyzer.broken = false;
    const shots = await client.callTool({
      name: "shot_list",
      arguments: { brief_id: brief.brief_id },
    });
    expect((shots.structuredContent as ShotsOut).shot_list.length).toBeGreaterThanOrEqual(4);
  });

  it("still no list after the retry: says so plainly instead of erroring", async () => {
    const analyzer = new SwitchableShots();
    const { url } = await server({ analyzer });
    const client = await connect(url);
    const res = await client.callTool({ name: "analyze_reference", arguments: { url: SHORT } });
    const id = (res.structuredContent as Structured).brief_id;
    const shots = await client.callTool({ name: "shot_list", arguments: { brief_id: id } });
    expect(shots.isError).toBeFalsy();
    const out = shots.structuredContent as ShotsOut;
    expect(out.shot_list).toEqual([]);
    expect(out.next_step).toMatch(/No shot list could be made/);
  });
});
