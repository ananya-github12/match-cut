/**
 * M2 acceptance: the full job lifecycle in mock mode, in memory.
 * PRD: "Backend: API contract", "Backend: architecture and request flow".
 */
import { MOCK_FAULT_IDS, MOCK_VIDEOS, MockAnalyzer } from "@match-cut/providers";
import { describe, expect, it, vi } from "vitest";
import { AUTH, harness } from "./helpers.js";

const SHORT = `https://youtube.com/shorts/${MOCK_VIDEOS.short.id}`;

describe("brief lifecycle", () => {
  it("POST returns 202 queued, then the job succeeds with a full brief", async () => {
    const h = harness({ autoRun: false });
    const res = await h.post({ source: { url: SHORT }, goal: "A launch video for my app" });
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe(`/v1/briefs/${res.json().id}`);
    expect(res.json()).toMatchObject({ status: "queued", stage: null, breakdown: null });
    expect(res.json().id).toMatch(/^brf_[0-9a-f]{32}$/);

    await h.drain();
    const brief = await h.brief(res.json().id);
    expect(brief).toMatchObject({
      status: "succeeded",
      stage: null,
      error: null,
      video: {
        id: "mockShort01",
        title: "Mock talking-head Short",
        channel: "Mock Channel",
        duration_seconds: 45,
        aspect_ratio: "9:16",
        analyzed_range: { start_seconds: 0, end_seconds: 45 },
      },
      meta: {
        model: "mock-flash",
        prompt_version: "p1.v1+p2.v3",
        schema_version: "s1",
        cached: false,
      },
    });
    expect(brief.breakdown?.beats.length).toBeGreaterThanOrEqual(2);
    expect(brief.cardboard_prompt).toContain("A launch video for my app");
    expect(brief.assets_needed?.length).toBeGreaterThan(0);
    expect(brief.watch_outs?.length).toBeGreaterThan(0);
    expect(brief.meta.tokens).toMatchObject({ pass1_input: 18000, pass2_output: 800 });
    expect(brief.meta.timings_ms.total).toBeGreaterThanOrEqual(0);
  });

  it("never returns the goal or the internal spoken lines", async () => {
    const h = harness();
    const { id } = (await h.post({ source: { url: SHORT }, goal: "secret goal text" })).json();
    await h.idle();
    const raw = (await h.get(id)).body;
    expect(raw).not.toContain('secret goal text"');
    expect(raw).not.toContain("spoken_lines_internal");
    expect(raw).not.toContain("Stop doing this one thing every morning.");
  });

  it("a repeat request is a full cache hit: 200 with the finished brief, no model calls", async () => {
    const analyzer = new MockAnalyzer();
    const watch = vi.spyOn(analyzer, "watch");
    const write = vi.spyOn(analyzer, "writePrompt");
    const h = harness({ analyzer });
    await h.post({ source: { url: SHORT }, goal: "Same goal" });
    await h.idle();

    const res = await h.post({
      source: { url: `https://youtu.be/${MOCK_VIDEOS.short.id}` },
      goal: "Same goal",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "succeeded", meta: { cached: true } });
    expect(res.json().cardboard_prompt).toContain("Same goal");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("a new goal on the same video reuses pass 1 and runs only pass 2", async () => {
    const analyzer = new MockAnalyzer();
    const watch = vi.spyOn(analyzer, "watch");
    const write = vi.spyOn(analyzer, "writePrompt");
    const h = harness({ analyzer });
    await h.post({ source: { url: SHORT }, goal: "First goal" });
    await h.idle();
    const res = await h.post({ source: { url: SHORT }, goal: "Second goal" });
    expect(res.statusCode).toBe(202);
    await h.idle();
    const brief = await h.brief(res.json().id);
    expect(brief.status).toBe("succeeded");
    expect(brief.cardboard_prompt).toContain("Second goal");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("detail, clip range and force_refresh each miss the pass 1 cache", async () => {
    const analyzer = new MockAnalyzer();
    const watch = vi.spyOn(analyzer, "watch");
    const h = harness({ analyzer });
    const body = { source: { url: SHORT } };
    await h.post(body);
    await h.idle();
    await h.post({ ...body, detail: "deep" });
    await h.idle();
    await h.post({ ...body, clip: { start_seconds: 0, end_seconds: 20 } });
    await h.idle();
    const forced = await h.post({ ...body, force_refresh: true });
    expect(forced.statusCode).toBe(202);
    await h.idle();
    expect(watch).toHaveBeenCalledTimes(4);
    const deep = watch.mock.calls[1]![0];
    expect(deep).toMatchObject({ detail: "deep", model: "mock-pro" });
    expect(watch.mock.calls[2]![0].range).toEqual({ start_seconds: 0, end_seconds: 20 });
  });

  it("sends Gemini only the canonical URL rebuilt from the ID", async () => {
    const analyzer = new MockAnalyzer();
    const watch = vi.spyOn(analyzer, "watch");
    const h = harness({ analyzer });
    await h.post({
      source: { url: `m.youtube.com/watch?v=${MOCK_VIDEOS.short.id}&si=abc&utm_source=x` },
    });
    await h.idle();
    expect(watch.mock.calls[0]![0].canonicalUrl).toBe(
      `https://www.youtube.com/watch?v=${MOCK_VIDEOS.short.id}`,
    );
  });
});

describe("idempotency and attaching", () => {
  it("the same Idempotency-Key returns the same job", async () => {
    const h = harness({ autoRun: false });
    const a = await h.post({ source: { url: SHORT } }, { "idempotency-key": "k1" });
    const b = await h.post(
      { source: { url: SHORT }, goal: "different" },
      { "idempotency-key": "k1" },
    );
    expect(b.statusCode).toBe(202);
    expect(b.json().id).toBe(a.json().id);
    expect(h.queue.jobs).toHaveLength(1);
  });

  it("idempotency keys are per user", async () => {
    const h = harness({ autoRun: false });
    const a = await h.post({ source: { url: SHORT } }, { "idempotency-key": "k1" });
    const b = await h.post(
      { source: { url: SHORT } },
      { "idempotency-key": "k1", "x-dev-user-id": "other" },
    );
    expect(b.json().id).not.toBe(a.json().id);
  });

  it("concurrent requests with one key create one job", async () => {
    const h = harness({ autoRun: false });
    const [a, b] = await Promise.all([
      h.post({ source: { url: SHORT } }, { "idempotency-key": "race" }),
      h.post({ source: { url: SHORT } }, { "idempotency-key": "race" }),
    ]);
    expect(a.json().id).toBe(b.json().id);
    expect(h.queue.jobs).toHaveLength(1);
  });

  it("the same analysis started twice while running attaches to the first job", async () => {
    const h = harness({ autoRun: false });
    const a = await h.post({ source: { url: SHORT }, goal: "g" });
    const b = await h.post({ source: { url: SHORT }, goal: "g" });
    expect(b.statusCode).toBe(202);
    expect(b.json().id).toBe(a.json().id);
    expect(h.queue.jobs).toHaveLength(1);
    // A different user does not attach.
    const c = await h.post({ source: { url: SHORT }, goal: "g" }, { "x-dev-user-id": "u2" });
    expect(c.json().id).not.toBe(a.json().id);
  });

  it("a replayed key after completion returns 200 with the finished brief", async () => {
    const h = harness();
    const a = await h.post({ source: { url: SHORT } }, { "idempotency-key": "done" });
    await h.idle();
    const b = await h.post({ source: { url: SHORT } }, { "idempotency-key": "done" });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ id: a.json().id, status: "succeeded" });
  });
});

describe("cancel and delete", () => {
  it("DELETE on a running job cancels it and the worker leaves it cancelled", async () => {
    const h = harness({ autoRun: false });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    expect((await h.del(id)).statusCode).toBe(204);
    expect((await h.brief(id)).status).toBe("cancelled");
    await h.drain();
    expect(await h.brief(id)).toMatchObject({ status: "cancelled", cardboard_prompt: null });
  });

  it("cancelling mid-pass aborts the model call and discards its result", async () => {
    const analyzer = new MockAnalyzer({ watchDelayMs: 5000 });
    const h = harness({ analyzer, autoRun: false });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    const running = h.drain();
    await vi.waitFor(async () => expect((await h.brief(id)).stage).toBe("watching"));
    await h.del(id);
    await running; // returns well before the 5 s delay because the call is aborted
    expect(await h.brief(id)).toMatchObject({ status: "cancelled", breakdown: null });
  });

  it("a cancelled request can be started again with the same inputs", async () => {
    const h = harness({ autoRun: false });
    const first = (await h.post({ source: { url: SHORT } })).json();
    await h.del(first.id);
    const again = await h.post({ source: { url: SHORT } });
    expect(again.statusCode).toBe(202);
    expect(again.json().id).not.toBe(first.id);
  });

  it("DELETE on a finished brief removes it", async () => {
    const h = harness();
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    await h.idle();
    expect((await h.del(id)).statusCode).toBe(204);
    const res = await h.get(id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("BRIEF_NOT_FOUND");
  });

  it("another user's brief is not found", async () => {
    const h = harness();
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    const res = await h.get(id, { ...AUTH, "x-dev-user-id": "someone-else" });
    expect(res.statusCode).toBe(404);
  });
});

describe("failures", () => {
  it("pass 1 failure: status failed with a retryable error", async () => {
    const h = harness();
    const { id } = (await h.post({ source: { url: MOCK_FAULT_IDS.pass1Fails } })).json();
    await h.idle();
    expect(await h.brief(id)).toMatchObject({
      status: "failed",
      breakdown: null,
      error: {
        code: "UPSTREAM_ERROR",
        message: "Something went wrong while analyzing.",
        retryable: true,
      },
    });
  });

  it("pass 2 failure: status partial with the breakdown and no prompt, then regenerate works", async () => {
    const h = harness();
    const { id } = (
      await h.post({ source: { url: SHORT }, goal: `boom ${MOCK_FAULT_IDS.pass2Fails}` })
    ).json();
    await h.idle();
    const partial = await h.brief(id);
    expect(partial).toMatchObject({ status: "partial", cardboard_prompt: null, error: null });
    expect(partial.breakdown).not.toBeNull();

    const res = await h.regenerate(id, { goal: "A calmer goal" });
    expect(res.statusCode).toBe(202);
    await h.idle();
    expect(await h.brief(id)).toMatchObject({ status: "succeeded" });
    expect((await h.brief(id)).cardboard_prompt).toContain("A calmer goal");
  });
});

describe("regenerate", () => {
  it("changes goal, format and length without re-watching", async () => {
    const analyzer = new MockAnalyzer();
    const watch = vi.spyOn(analyzer, "watch");
    const h = harness({ analyzer });
    const { id } = (await h.post({ source: { url: SHORT }, goal: "Original" })).json();
    await h.idle();
    const res = await h.regenerate(id, {
      goal: "Recipe video",
      target: { format: "16:9", length_seconds: 30 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id, status: "queued", cardboard_prompt: null });
    expect(res.json().breakdown).not.toBeNull();
    await h.idle();
    const brief = await h.brief(id);
    expect(brief.status).toBe("succeeded");
    expect(brief.cardboard_prompt).toContain("Recipe video");
    expect(brief.cardboard_prompt).toContain("horizontal 16:9");
    expect(brief.cardboard_prompt).toContain("0:30");
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("returns 200 at once when that prompt is already cached", async () => {
    const h = harness();
    const { id } = (await h.post({ source: { url: SHORT }, goal: "A" })).json();
    await h.idle();
    await h.regenerate(id, { goal: "B" });
    await h.idle();
    const back = await h.regenerate(id, { goal: "A" });
    expect(back.statusCode).toBe(200);
    expect(back.json().cardboard_prompt).toContain("A, using the structure");
  });

  it("is refused while the brief is still running", async () => {
    const h = harness({ autoRun: false });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    const res = await h.regenerate(id, { goal: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("BRIEF_NOT_READY");
  });

  it("validates its body", async () => {
    const h = harness();
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    await h.idle();
    expect((await h.regenerate(id, { goal: "x".repeat(1501) })).json().error.code).toBe(
      "GOAL_TOO_LONG",
    );
    expect((await h.regenerate(id, { target: { format: "3:2" } })).json().error.code).toBe(
      "INVALID_REQUEST",
    );
  });
});

describe("fallback models", () => {
  it("a breakdown from a fallback model is labeled and not cached", async () => {
    const analyzer = new MockAnalyzer();
    const watch = vi.spyOn(analyzer, "watch").mockImplementation(async (i) => ({
      ...(await new MockAnalyzer().watch(i)),
      model: "mock-fallback",
      fallbackUsed: true,
      attempts: 3,
    }));
    const h = harness({ analyzer });
    const first = (await h.post({ source: { url: SHORT } })).json();
    await h.idle();
    expect(await h.brief(first.id)).toMatchObject({
      status: "succeeded",
      meta: { model: "mock-fallback" },
    });

    // Same request again: not a cache hit, so the standard model gets another chance.
    const again = await h.post({ source: { url: SHORT } });
    expect(again.statusCode).toBe(202);
    await h.idle();
    expect(watch).toHaveBeenCalledTimes(2);
  });
});

describe("breakdown warnings", () => {
  it("a video with no speech gets NO_SPEECH, including on a later full cache hit", async () => {
    const h = harness();
    const res = await h.post({ source: { url: MOCK_VIDEOS.montage.id } });
    await h.idle();
    const brief = await h.brief(res.json().id);
    expect(brief.status).toBe("succeeded");
    expect(brief.breakdown?.style.delivery).toBe("not applicable");
    expect(brief.warnings).toEqual([
      {
        code: "NO_SPEECH",
        message: "No speech found, so the prompt focuses on pacing, music and graphics.",
      },
    ]);
    const hit = await h.post({ source: { url: MOCK_VIDEOS.montage.id } });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().warnings.map((w: { code: string }) => w.code)).toEqual(["NO_SPEECH"]);
  });
});

describe("request validation and precheck errors", () => {
  const cases: [string, unknown, number, string][] = [
    ["missing url", {}, 400, "INVALID_URL"],
    ["malformed url", { source: { url: "not a link" } }, 400, "INVALID_URL"],
    ["instagram", { source: { url: "https://instagram.com/reel/abc" } }, 400, "UNSUPPORTED_SOURCE"],
    ["goal too long", { source: { url: SHORT }, goal: "x".repeat(1501) }, 400, "GOAL_TOO_LONG"],
    [
      "clip end before start",
      { source: { url: SHORT }, clip: { start_seconds: 20, end_seconds: 10 } },
      400,
      "INVALID_CLIP_RANGE",
    ],
    [
      "clip as text",
      { source: { url: SHORT }, clip: { start_seconds: "0:10" } },
      400,
      "INVALID_CLIP_RANGE",
    ],
    ["bad format", { source: { url: SHORT }, target: { format: "3:2" } }, 400, "INVALID_REQUEST"],
    [
      "length out of range",
      { source: { url: SHORT }, target: { length_seconds: 4 } },
      400,
      "INVALID_REQUEST",
    ],
    [
      "bad language",
      { source: { url: SHORT }, output_language: "english!" },
      400,
      "INVALID_REQUEST",
    ],
    ["unknown field", { source: { url: SHORT }, extra: true }, 400, "INVALID_REQUEST"],
    ["not found", { source: { url: "mockGone001" } }, 404, "VIDEO_NOT_FOUND"],
    ["private", { source: { url: MOCK_VIDEOS.private.id } }, 422, "VIDEO_NOT_PUBLIC"],
    ["age-restricted", { source: { url: MOCK_VIDEOS.ageRestricted.id } }, 422, "VIDEO_RESTRICTED"],
    ["live", { source: { url: MOCK_VIDEOS.live.id } }, 422, "LIVE_NOT_SUPPORTED"],
    ["too long without clip", { source: { url: MOCK_VIDEOS.long.id } }, 422, "VIDEO_TOO_LONG"],
    ["too short", { source: { url: MOCK_VIDEOS.tiny.id } }, 422, "NO_ANALYZABLE_CONTENT"],
  ];
  it.each(cases)("%s", async (_name, body, status, code) => {
    const h = harness();
    const res = await h.post(body);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(h.queue.jobs).toHaveLength(0);
  });

  it("malformed JSON is INVALID_REQUEST", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/briefs",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUEST");
  });

  it("no token is 401", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/briefs",
      payload: { source: { url: SHORT } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("warnings from the link and precheck land on the brief", async () => {
    const h = harness();
    const res = await h.post({
      source: { url: `https://youtu.be/${MOCK_VIDEOS.embedDisabled.id}?t=30` },
      clip: { start_seconds: 10, end_seconds: 999 },
    });
    expect(res.json().warnings).toEqual([
      {
        code: "TIMESTAMP_IGNORED",
        message: "The link's start time was ignored. Set a clip range to analyze one part.",
      },
      { code: "EMBED_DISABLED", message: "The creator has turned off playback outside YouTube." },
      {
        code: "CLIP_CLAMPED",
        message: "Your end time was past the end of the video, so we analyzed up to 1:00.",
      },
    ]);
    expect(res.json().video.analyzed_range).toEqual({ start_seconds: 10, end_seconds: 60 });
  });
});
