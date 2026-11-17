/**
 * Brief endpoints. PRD: "Backend: API contract".
 *   POST   /v1/briefs                 202 with job, or 200 with the finished brief on a full cache hit
 *   GET    /v1/briefs/{id}            status and result
 *   GET    /v1/briefs/{id}/events     server-sent events, one `brief` event per change
 *   POST   /v1/briefs/{id}/regenerate new prompt from the stored breakdown; 202, or 200 on cache hit
 *   DELETE /v1/briefs/{id}            cancel a running job, or delete a finished brief; 204
 */
import { randomUUID } from "node:crypto";
import {
  breakdownWarnings,
  briefKeys,
  createBriefRequestSchema,
  GOAL_MAX_CHARS,
  INFLIGHT_TTL_SECONDS,
  isTerminal,
  MatchCutError,
  pass1OutputSchema,
  pass2OutputSchema,
  parseYouTubeSource,
  regenerateRequestSchema,
  warning,
  type CapabilityManifest,
  type Limits,
  type ModelNames,
  type Warning,
} from "@match-cut/core";
import {
  toBriefResponse,
  type LimitKind,
  type RateLimiter,
  type SpendTracker,
  type Who,
  type BriefEvents,
  type BriefRecord,
  type BriefStore,
  type JobQueue,
  type KV,
} from "@match-cut/infra";
import { precheck, type VideoLookup } from "@match-cut/providers";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface BriefsRouteDeps {
  store: BriefStore;
  kv: KV;
  events: BriefEvents;
  queue: JobQueue;
  lookup: VideoLookup;
  region: string;
  limits: Limits;
  models: ModelNames;
  manifest: CapabilityManifest;
  authenticate: (req: FastifyRequest) => Promise<void>;
  /** SSE keep-alive interval. */
  heartbeatMs?: number;
  limiter?: RateLimiter;
  spend?: SpendTracker;
  /**
   * PRD "Job store down": run a short video synchronously when the brief can't be stored or
   * queued. Returns the finished brief (not retrievable later).
   */
  syncRun?: (record: BriefRecord) => Promise<BriefRecord>;
  /** Longest analyzed section eligible for the synchronous fallback. PRD: 3 minutes. */
  syncMaxSeconds?: number;
}

async function takeSlot(deps: BriefsRouteDeps, kind: LimitKind, who: Who): Promise<void> {
  if (!deps.limiter) return;
  const r = await deps.limiter.take(kind, who);
  if (!r.ok) {
    throw new MatchCutError(
      "RATE_LIMITED",
      { minutes: Math.max(1, Math.ceil(r.retryAfterSeconds / 60)) },
      { retryAfterSeconds: r.retryAfterSeconds, rule: r.rule },
    );
  }
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

const newBriefId = () => `brf_${randomUUID().replace(/-/g, "")}`;

/** Maps body problems to the PRD's codes, checked in the order a user would fix them. */
function parseCreateBody(body: unknown) {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const source = b.source as Record<string, unknown> | undefined;
  if (typeof source?.url !== "string") throw new MatchCutError("INVALID_URL");
  const parsedUrl = parseYouTubeSource(source.url);
  if (!parsedUrl.ok) throw new MatchCutError(parsedUrl.code);
  if (b.goal !== undefined && typeof b.goal === "string" && b.goal.length > GOAL_MAX_CHARS) {
    throw new MatchCutError("GOAL_TOO_LONG");
  }
  const clip = b.clip as Record<string, unknown> | undefined;
  if (
    clip !== undefined &&
    (typeof clip !== "object" ||
      clip === null ||
      [clip.start_seconds, clip.end_seconds].some((v) => v !== undefined && typeof v !== "number"))
  ) {
    throw new MatchCutError("INVALID_CLIP_RANGE");
  }
  const parsed = createBriefRequestSchema.safeParse(b);
  if (!parsed.success) throw new MatchCutError("INVALID_REQUEST");
  return { req: parsed.data, source: parsedUrl };
}

async function loadOwned(store: BriefStore, id: string, userId: string): Promise<BriefRecord> {
  const brief = await store.get(id);
  if (!brief || brief.userId !== userId) throw new MatchCutError("BRIEF_NOT_FOUND");
  return brief;
}

function send(reply: FastifyReply, brief: BriefRecord) {
  const status = isTerminal(brief.status) ? 200 : 202;
  if (status === 202) reply.header("location", `/v1/briefs/${brief.id}`);
  return reply.status(status).send(toBriefResponse(brief));
}

export async function briefsRoutes(app: FastifyInstance, deps: BriefsRouteDeps) {
  const { store, kv, events, queue } = deps;
  const manifestVersion = deps.manifest.manifest_version;
  const auth = { preHandler: deps.authenticate };

  /** Waits briefly for a brief another request is creating (idempotency race). */
  async function waitForBrief(id: string): Promise<BriefRecord | null> {
    for (let i = 0; i < 20; i++) {
      const b = await store.get(id);
      if (b) return b;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  app.post("/v1/briefs", auth, async (req, reply) => {
    const { userId, orgId } = req.auth;

    const idemHeader = req.headers["idempotency-key"];
    const idemKey =
      typeof idemHeader === "string" && idemHeader.length > 0 ? idemHeader : undefined;
    if (idemKey !== undefined && !IDEMPOTENCY_KEY.test(idemKey)) {
      throw new MatchCutError("INVALID_REQUEST");
    }
    const idemStoreKey = idemKey ? `idem:${userId}:${idemKey}` : null;
    if (idemStoreKey) {
      const existingId = await kv.get(idemStoreKey);
      const existing = existingId ? await waitForBrief(existingId) : null;
      if (existing && existing.userId === userId) return send(reply, existing);
    }

    // PRD: bad-input failures count toward rate limits, so take the slot before validating.
    const who = { userId, orgId };
    await takeSlot(deps, "analyze", who);
    const slotTakenAt = new Date();
    const { req: body, source } = parseCreateBody(req.body);

    const check = await precheck(deps.lookup, source.videoId, body.clip, {
      region: deps.region,
      limits: deps.limits,
    });
    if (!check.ok) throw new MatchCutError(check.code);

    const warnings: Warning[] = [
      ...source.warnings.map((code) => warning(code)),
      ...check.warnings.map((w) => warning(w.code, w.vars)),
    ];
    const now = new Date();
    const record: BriefRecord = {
      id: newBriefId(),
      userId,
      orgId,
      status: "queued",
      stage: null,
      videoId: source.videoId,
      video: check.video && {
        title: check.video.title,
        channel: check.video.channel,
        durationSeconds: check.video.durationSeconds,
        embeddable: check.video.embeddable,
      },
      range: check.range,
      detail: body.detail,
      goal: body.goal?.trim() ?? "",
      targetFormat: body.target.format,
      targetLengthSeconds: body.target.length_seconds ?? null,
      outputLanguage: body.output_language,
      forceRefresh: body.force_refresh,
      breakdown: null,
      spokenLines: null,
      prompt: null,
      warnings,
      error: null,
      meta: {
        model: null,
        pass2Model: null,
        cached: false,
        timingsMs: {},
        tokens: {},
      },
      createdAt: now,
      updatedAt: now,
    };
    const keys = briefKeys(record, deps.models, manifestVersion);

    // Claim the idempotency key; a concurrent request with the same key gets this brief.
    if (idemStoreKey) {
      const claimed = await kv.setIfAbsent(idemStoreKey, record.id, IDEMPOTENCY_TTL_SECONDS);
      if (!claimed) {
        const otherId = await kv.get(idemStoreKey);
        const other = otherId ? await waitForBrief(otherId) : null;
        if (other && other.userId === userId) return send(reply, other);
      }
    }

    if (!body.force_refresh) {
      // Same user, same request, still running: attach to it.
      const runningId = await kv.get(keys.inflight);
      const running = runningId ? await store.get(runningId) : null;
      if (running && running.userId === userId && !isTerminal(running.status)) {
        if (idemStoreKey) await kv.set(idemStoreKey, running.id, IDEMPOTENCY_TTL_SECONDS);
        return send(reply, running);
      }

      // Full cache hit: both passes cached, return the finished brief now.
      const [p1, p2] = await Promise.all([kv.get(keys.pass1), kv.get(keys.pass2)]);
      if (p1 && p2) {
        const p1Out = pass1OutputSchema.parse(JSON.parse(p1));
        const { spoken_lines_internal, ...breakdown } = p1Out;
        const done: BriefRecord = {
          ...record,
          warnings: [...record.warnings, ...breakdownWarnings(p1Out).map((c) => warning(c))],
          status: "succeeded",
          breakdown,
          spokenLines: spoken_lines_internal,
          prompt: pass2OutputSchema.parse(JSON.parse(p2)),
          meta: {
            ...record.meta,
            model: body.detail === "deep" ? deps.models.deep : deps.models.standard,
            pass2Model: deps.models.pass2,
            cached: true,
            pass1Cached: true,
            pass2Cached: true,
            timingsMs: { total: Date.now() - now.getTime() },
          },
        };
        await store.create(done);
        return reply.status(200).send(toBriefResponse(done));
      }
    }

    if (deps.spend && (await deps.spend.overCap())) {
      await deps.limiter?.refund("analyze", who, slotTakenAt);
      throw new MatchCutError("CAPACITY_EXHAUSTED", {}, { reason: "spend_cap" });
    }

    let created = false;
    try {
      await store.create(record);
      created = true;
      await kv.set(keys.inflight, record.id, INFLIGHT_TTL_SECONDS);
      await queue.enqueue({ briefId: record.id, kind: "analyze" });
    } catch (e) {
      req.log.error({ err: (e as Error).message, briefId: record.id }, "job store unavailable");
      if (created) await store.delete(record.id).catch(() => {});
      const seconds = record.range
        ? record.range.end_seconds - record.range.start_seconds
        : record.video?.durationSeconds;
      if (deps.syncRun && seconds !== undefined && seconds <= (deps.syncMaxSeconds ?? 180)) {
        const done = await deps.syncRun({ ...record, status: "queued" });
        return reply.status(200).send(toBriefResponse(done));
      }
      throw new MatchCutError("INTERNAL", {}, { reason: "job_store_down" });
    }
    return send(reply, record);
  });

  app.get<{ Params: { id: string } }>("/v1/briefs/:id", auth, async (req) => {
    return toBriefResponse(await loadOwned(store, req.params.id, req.auth.userId));
  });

  app.post<{ Params: { id: string } }>("/v1/briefs/:id/regenerate", auth, async (req, reply) => {
    const brief = await loadOwned(store, req.params.id, req.auth.userId);
    await takeSlot(deps, "regenerate", req.auth);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof raw.goal === "string" && raw.goal.length > GOAL_MAX_CHARS) {
      throw new MatchCutError("GOAL_TOO_LONG");
    }
    const parsed = regenerateRequestSchema.safeParse(raw);
    if (!parsed.success) throw new MatchCutError("INVALID_REQUEST");
    if (!brief.breakdown || !(brief.status === "succeeded" || brief.status === "partial")) {
      throw new MatchCutError("BRIEF_NOT_READY");
    }
    const r = parsed.data;
    const next: BriefRecord = {
      ...brief,
      goal: r.goal !== undefined ? r.goal.trim() : brief.goal,
      targetFormat: r.target?.format ?? brief.targetFormat,
      targetLengthSeconds:
        r.target?.length_seconds !== undefined
          ? r.target.length_seconds
          : brief.targetLengthSeconds,
      outputLanguage: r.output_language ?? brief.outputLanguage,
    };
    const inputs = {
      goal: next.goal,
      targetFormat: next.targetFormat,
      targetLengthSeconds: next.targetLengthSeconds,
      outputLanguage: next.outputLanguage,
    };
    const keys = briefKeys(next, deps.models, manifestVersion);

    const cached = await kv.get(keys.pass2);
    if (cached) {
      const updated = await store.update(brief.id, {
        ...inputs,
        status: "succeeded",
        stage: null,
        error: null,
        prompt: pass2OutputSchema.parse(JSON.parse(cached)),
        meta: { ...brief.meta, pass2Cached: true },
      });
      await events.publish(brief.id);
      return reply.status(200).send(toBriefResponse(updated!));
    }

    if (deps.spend && (await deps.spend.overCap())) {
      throw new MatchCutError("CAPACITY_EXHAUSTED", {}, { reason: "spend_cap" });
    }
    const updated = await store.update(brief.id, {
      ...inputs,
      status: "queued",
      stage: null,
      error: null,
      prompt: null,
    });
    await events.publish(brief.id);
    await queue.enqueue({ briefId: brief.id, kind: "regenerate" });
    return send(reply, updated!);
  });

  app.delete<{ Params: { id: string } }>("/v1/briefs/:id", auth, async (req, reply) => {
    const brief = await loadOwned(store, req.params.id, req.auth.userId);
    if (!isTerminal(brief.status)) {
      // Cancel. Any cached pass 1 result is kept (PRD).
      await store.update(brief.id, { status: "cancelled", stage: null });
      await kv.del(briefKeys(brief, deps.models, manifestVersion).inflight);
    } else {
      await store.delete(brief.id);
    }
    await events.publish(brief.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/v1/briefs/:id/events", auth, async (req, reply) => {
    const id = req.params.id;
    await loadOwned(store, id, req.auth.userId);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let closed = false;
    let chain = Promise.resolve();
    const subscription: { off?: () => Promise<void> } = {};
    const heartbeat = setInterval(() => res.write(": ping\n\n"), deps.heartbeatMs ?? 15000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void subscription.off?.();
      res.end();
    };
    req.raw.on("close", close);

    // Each push sends the full brief object; sends are chained so they stay in order.
    let lastSent = "";
    const push = () => {
      chain = chain.then(async () => {
        if (closed) return;
        const b = await store.get(id);
        if (!b || b.userId !== req.auth.userId) {
          res.write(
            `event: error\ndata: ${JSON.stringify(new MatchCutError("BRIEF_NOT_FOUND").error)}\n\n`,
          );
          return close();
        }
        const data = JSON.stringify(toBriefResponse(b));
        if (data !== lastSent) {
          res.write(`event: brief\ndata: ${data}\n\n`);
          lastSent = data;
        }
        if (isTerminal(b.status)) close();
      });
    };

    // Subscribe before the first snapshot so no change is missed in between.
    subscription.off = await events.subscribe(id, push);
    if (closed) await subscription.off();
    push();
  });
}
