/**
 * M10.8: playbook and skill tools on the Match Cut MCP server, driven by the official MCP client
 * over real HTTP, in mock mode. PRD-playbooks.md, Features 3 and 4.
 */
import { MOCK_VIDEOS } from "@match-cut/providers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function server(opts: { autoRun?: boolean; playbooks?: boolean } = {}) {
  const h = harness({
    autoRun: opts.autoRun ?? true,
    app: {
      mcp: { keys: [KEY_A, KEY_B], waitMs: 3000, pollMs: 20 },
      ...(opts.playbooks === false ? { playbooks: undefined } : {}),
    },
  });
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  open.push(h.app);
  const address = h.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { h, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

async function connect(url: URL, key = KEY_A) {
  const client = new Client({ name: "match-cut-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  open.push(client);
  return client;
}

const text = (r: { content?: unknown }) =>
  ((r.content as { type: string; text: string }[] | undefined) ?? []).map((c) => c.text).join("\n");
type Out = Record<string, unknown> & { next_step: string };
const out = (r: { structuredContent?: unknown }): unknown => r.structuredContent;

async function playbook(client: Client, channel = "@mockgolden01") {
  return client.callTool({ name: "build_playbook", arguments: { channel } });
}

describe("MCP playbook and skill tools", () => {
  it("shot_list plans shots from a playbook or a skill, and needs exactly one ID", async () => {
    const { url } = await server();
    const client = await connect(url);
    const { playbook_id } = out(await playbook(client)) as Out & { playbook_id: string };
    const res = await client.callTool({
      name: "shot_list",
      arguments: { playbook_id, goal: "my coffee cart", length_seconds: 20 },
    });
    expect(res.isError).toBeFalsy();
    const o = out(res) as Out & { brief_id: null; source: unknown; total_seconds: number };
    expect(o).toMatchObject({ brief_id: null, source: { type: "playbook", id: playbook_id } });
    expect(o.total_seconds).toBe(20);
    expect(text(res)).toMatch(/Shot list for this playbook \(4 shots/);
    expect(text(res)).toContain("[step 1,");
    const both = await client.callTool({
      name: "shot_list",
      arguments: { playbook_id, skill_id: `skl_${"0".repeat(32)}` },
    });
    expect(both.isError).toBe(true);
    const none = await client.callTool({ name: "shot_list", arguments: {} });
    expect(none.isError).toBe(true);
    // apply_playbook needs exactly one of playbook_id and skill_id too.
    const neither = await client.callTool({ name: "apply_playbook", arguments: { goal: "x" } });
    expect(text(neither)).toMatch(/either playbook_id or skill_id/);
  });

  it("are offered only when the deployment has playbooks, with honest instructions", async () => {
    const off = await server({ playbooks: false });
    const names = (await (await connect(off.url)).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("build_playbook");
    const on = await server();
    const client = await connect(on.url);
    const tools = (await client.listTools()).tools;
    const analyze = tools.find((t) => t.name === "build_playbook")!;
    expect(analyze.inputSchema.required).toEqual(["channel"]);
    expect(analyze.description).toMatch(/not as proof/);
    expect(client.getInstructions()).toMatch(/never as proof/);
    expect(tools.find((t) => t.name === "apply_playbook")!.description).toMatch(/confirmation/);
  });

  it("build_playbook returns rules with evidence counts and what the edit doesn't explain", async () => {
    const { url } = await server();
    const client = await connect(url);
    const res = await playbook(client);
    expect(res.isError).toBeFalsy();
    const t = text(res);
    expect(t).toContain("What the breakouts share (patterns, not proof of cause):");
    expect(t).toMatch(/\((high|medium); \d+ of \d+ breakouts · \d+ of \d+ typical\)/);
    expect(t).toContain("What the edit doesn't explain:");
    const o = out(res) as Out & {
      status: string;
      playbook_id: string;
      rules: { evidence: string }[];
      breakouts: unknown[];
    };
    expect(o.status).toBe("succeeded");
    expect(o.playbook_id).toMatch(/^pbk_[0-9a-f]{32}$/);
    expect(o.rules[0]!.evidence).toMatch(/^\d+ of \d+ breakouts · \d+ of \d+ typical$/);
    expect(o.breakouts.length).toBeGreaterThanOrEqual(3);
    expect(o.next_step).toMatch(/apply_playbook/);
    expect(JSON.stringify(res)).not.toMatch(/spokenLines|spoken_lines/);
  });

  it("returns the API's messages for a bad channel and for too little data", async () => {
    const { url } = await server();
    const client = await connect(url);
    const missing = await playbook(client, "@mockgone");
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/couldn't find that channel.*\(CHANNEL_NOT_FOUND\)/);
    const tiny = await playbook(client, "@mocktiny");
    expect(tiny.isError).toBe(true);
    expect(text(tiny)).toMatch(
      /Found \d+ eligible Shorts.*needs at least 10, 3 and 3.*NOT_ENOUGH_DATA/,
    );
  });

  it("a slow playbook hands back its ID; get_playbook picks it up", async () => {
    const { h, url } = await server({ autoRun: false });
    const client = await connect(url);
    const started = await playbook(client, "@mockgolden02");
    const o = out(started) as Out & { status: string; playbook_id: string };
    expect(o.status).toBe("queued");
    expect(o.next_step).toMatch(/get_playbook/);
    await h.drain();
    const done = await client.callTool({
      name: "get_playbook",
      arguments: { playbook_id: o.playbook_id },
    });
    expect((out(done) as { status: string }).status).toBe("succeeded");
    const bad = await client.callTool({ name: "get_playbook", arguments: { playbook_id: "nope" } });
    expect(bad.isError).toBe(true);
  });

  it("apply_playbook writes a prompt and shots for the user's video", async () => {
    const { url } = await server();
    const client = await connect(url);
    const { playbook_id } = out(await playbook(client)) as Out & { playbook_id: string };
    const res = await client.callTool({
      name: "apply_playbook",
      arguments: { playbook_id, goal: "a video about my coffee cart", length_seconds: 30 },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("my coffee cart");
    expect(text(res)).toMatch(/What to film \(4 shots\)/);
    const o = out(res) as Out & { shot_list: unknown[]; source: unknown };
    expect(o.shot_list).toHaveLength(4);
    expect(o.source).toEqual({ type: "playbook", id: playbook_id });
    expect(o.next_step).toMatch(/confirm/);
  });

  it("saves playbooks and briefs as skills, lists them and applies them", async () => {
    const { url } = await server();
    const client = await connect(url);
    const { playbook_id } = out(await playbook(client)) as Out & { playbook_id: string };
    const saved = await client.callTool({
      name: "save_skill",
      arguments: { name: "Question hooks", playbook_id },
    });
    expect(saved.isError).toBeFalsy();
    const { skill_id } = out(saved) as Out & { skill_id: string };
    expect(skill_id).toMatch(/^skl_[0-9a-f]{32}$/);

    const brief = await client.callTool({
      name: "analyze_reference",
      arguments: { url: MOCK_VIDEOS.short.id },
    });
    const { brief_id } = out(brief) as Out & { brief_id: string };
    const fromBrief = await client.callTool({
      name: "save_skill",
      arguments: { name: "Talking head", brief_id },
    });
    expect(fromBrief.isError).toBeFalsy();

    const list = await client.callTool({ name: "list_skills", arguments: {} });
    expect((out(list) as { skills: { name: string }[] }).skills.map((s) => s.name).sort()).toEqual([
      "Question hooks",
      "Talking head",
    ]);
    const applied = await client.callTool({
      name: "apply_playbook",
      arguments: { skill_id, goal: "my bakery", format: "9:16" },
    });
    expect(applied.isError).toBeFalsy();
    expect(text(applied)).toContain("my bakery");

    for (const args of [{ name: "x" }, { name: "x", brief_id, playbook_id }]) {
      const res = await client.callTool({ name: "save_skill", arguments: args });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/either brief_id or playbook_id, not both/);
    }
  });

  it("each key is its own user", async () => {
    const { url } = await server();
    const a = await connect(url, KEY_A);
    const b = await connect(url, KEY_B);
    const { playbook_id } = out(await playbook(a)) as Out & { playbook_id: string };
    const res = await b.callTool({ name: "get_playbook", arguments: { playbook_id } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("PLAYBOOK_NOT_FOUND");
    expect(
      (out(await b.callTool({ name: "list_skills", arguments: {} })) as { skills: unknown[] })
        .skills,
    ).toEqual([]);
  });
});
