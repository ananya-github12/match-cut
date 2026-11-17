/** Server-sent events over a real socket. */
import { MOCK_VIDEOS, MockAnalyzer } from "@match-cut/providers";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH, harness } from "./helpers.js";

type H = ReturnType<typeof harness>;
let current: H | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function readEvents(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text(); // the server closes the stream at a terminal status
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) };
    });
}

describe("GET /v1/briefs/{id}/events", () => {
  it("streams every stage in order and closes at the terminal status", async () => {
    const h = (current = harness({
      analyzer: new MockAnalyzer({ watchDelayMs: 30, writeDelayMs: 30 }),
      autoRun: false,
    }));
    const base = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { id } = (await h.post({ source: { url: MOCK_VIDEOS.short.id } })).json();

    const events = readEvents(`${base}/v1/briefs/${id}/events`, AUTH);
    await new Promise((r) => setTimeout(r, 50));
    await h.drain();
    const seen = (await events).map(
      (e) => `${e.data.status}${e.data.stage ? `:${e.data.stage}` : ""}`,
    );

    expect(seen[0]).toBe("queued");
    expect(seen.at(-1)).toBe("succeeded");
    for (const s of ["processing:watching", "processing:writing_prompt", "processing:validating"]) {
      expect(seen).toContain(s);
    }
    expect(seen.indexOf("processing:watching")).toBeLessThan(
      seen.indexOf("processing:writing_prompt"),
    );
  });

  it("sends one event and closes when the brief is already finished", async () => {
    const h = (current = harness());
    const base = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { id } = (await h.post({ source: { url: MOCK_VIDEOS.short.id } })).json();
    await h.idle();
    const events = await readEvents(`${base}/v1/briefs/${id}/events`, AUTH);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "brief", data: { id, status: "succeeded" } });
  });

  it("ends with the cancelled status when the job is cancelled", async () => {
    const h = (current = harness({ autoRun: false }));
    const base = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { id } = (await h.post({ source: { url: MOCK_VIDEOS.short.id } })).json();
    const events = readEvents(`${base}/v1/briefs/${id}/events`, AUTH);
    await new Promise((r) => setTimeout(r, 50));
    await h.del(id);
    expect((await events).at(-1)?.data.status).toBe("cancelled");
  });

  it("requires auth and ownership", async () => {
    const h = (current = harness());
    const base = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { id } = (await h.post({ source: { url: MOCK_VIDEOS.short.id } })).json();
    expect((await fetch(`${base}/v1/briefs/${id}/events`)).status).toBe(401);
    const other = await fetch(`${base}/v1/briefs/${id}/events`, {
      headers: { ...AUTH, "x-dev-user-id": "x" },
    });
    expect(other.status).toBe(404);
  });
});
