/**
 * M9: the Match Cut MCP server, driven by the official MCP client over real HTTP, in mock mode.
 * PRD-playbooks.md, Feature 1.
 */
import { MOCK_FAULT_IDS, MOCK_VIDEOS } from "@match-cut/providers";
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
async function server(opts: { autoRun?: boolean; keys?: string[] } = {}) {
  const h = harness({
    autoRun: opts.autoRun ?? true,
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
