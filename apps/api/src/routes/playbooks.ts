/**
 * Playbook endpoints. PRD-playbooks.md, "API additions" (same auth, JSON and idempotency rules
 * as v1).
 *   POST   /v1/playbooks             202 with the job, or 200 with a finished playbook for the
 *                                    same channel and settings from the last 24 h
 *   GET    /v1/playbooks/{id}        status and result
 *   GET    /v1/playbooks/{id}/events server-sent events, one `playbook` event per change
 *   POST   /v1/playbooks/{id}/apply  prompt and shot list for a goal, format, length, language
 *   DELETE /v1/playbooks/{id}        cancel a running playbook, or delete a finished one; 204
 */
import { randomUUID } from "node:crypto";
import {
  applyRequestSchema,
  createPlaybookRequestSchema,
  GOAL_MAX_CHARS,
  isTerminal,
  MatchCutError,
  parseChannelSource,
  playbookInflightKey,
  releasePlaybookInflight,
  type ChannelRef,
} from "@match-cut/core";
import {
  toPlaybookResponse,
  type BriefEvents,
  type PlaybookJobQueue,
  type PlaybookRecord,
  type PlaybookSettings,
  type PlaybookStore,
  type RateLimiter,
  type SpendTracker,
  type Who,
} from "@match-cut/infra";
import type { ChannelInfo, ChannelLookup } from "@match-cut/providers";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { runApply, type ApplyDeps } from "../apply.js";
import { streamEvents } from "../sse.js";

export interface PlaybooksRouteDeps extends ApplyDeps {
  playbooks: PlaybookStore;
  events: BriefEvents;
  queue: PlaybookJobQueue;
  channels: ChannelLookup;
  authenticate: (req: FastifyRequest) => Promise<void>;
  heartbeatMs?: number;
  limiter?: RateLimiter;
  spend?: SpendTracker;
  now?: () => number;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
/** A running playbook takes minutes; a repeat request meanwhile attaches to it. */
const INFLIGHT_TTL_SECONDS = 20 * 60;
/** PRD: a finished playbook for the same channel and settings within 24 h is returned (200). */
const REPEAT_WINDOW_MS = 24 * 3600_000;
const RUNNING = ["queued", "processing"] as const;

const newPlaybookId = () => `pbk_${randomUUID().replace(/-/g, "")}`;

export async function takeSlot(
  limiter: RateLimiter | undefined,
  kind: "playbook" | "regenerate",
  who: Who,
): Promise<Date> {
  const at = new Date();
  if (!limiter) return at;
  const r = await limiter.take(kind, who);
  if (!r.ok) throw rateLimited(r);
  return at;
}

const rateLimited = (r: { retryAfterSeconds: number; rule: string }) =>
  new MatchCutError(
    "RATE_LIMITED",
    { minutes: Math.max(1, Math.ceil(r.retryAfterSeconds / 60)) },
    { retryAfterSeconds: r.retryAfterSeconds, rule: r.rule },
  );

/** Apply's body: goal length first (GOAL_TOO_LONG), then the shape (INVALID_REQUEST). */
export function parseApplyBody(body: unknown) {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof raw.goal === "string" && raw.goal.length > GOAL_MAX_CHARS) {
    throw new MatchCutError("GOAL_TOO_LONG");
  }
  const parsed = applyRequestSchema.safeParse(raw);
  if (!parsed.success) throw new MatchCutError("INVALID_REQUEST");
  return parsed.data;
}

/** Body problems mapped to the PRD's codes, in the order a user would fix them. */
function parseCreateBody(body: unknown): {
  ref: ChannelRef | "mine";
  settings: PlaybookSettings;
  forceRefresh: boolean;
} {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const source = b.source as Record<string, unknown> | undefined;
  const isMine = source?.mine === true;
  if (!isMine) {
    if (typeof source?.channel !== "string") throw new MatchCutError("INVALID_URL");
    const parsedRef = parseChannelSource(source.channel);
    if (!parsedRef.ok) throw new MatchCutError(parsedRef.code);
  }
  const parsed = createPlaybookRequestSchema.safeParse(b);
  if (!parsed.success) throw new MatchCutError("INVALID_REQUEST");
  const p = parsed.data;
  const settings = {
    windowDays: p.window_days,
    maxVideos: p.max_videos,
    outlierThreshold: p.outlier_threshold,
  };
  if ("mine" in p.source) return { ref: "mine", settings, forceRefresh: p.force_refresh };
  const ref = parseChannelSource(p.source.channel);
  if (!ref.ok) throw new MatchCutError(ref.code);
  return { ref: ref.ref, settings, forceRefresh: p.force_refresh };
}

/** A playbook made with a fallback, or missing videos, isn't served as the 24-hour repeat. */
export function isDegraded(p: PlaybookRecord): boolean {
  return Boolean(
    (p.meta.skipped ?? 0) > 0 ||
    p.meta.writerFailed ||
    p.meta.fallbacksUsed ||
    p.meta.fallbackModelUsed,
  );
}

const inflightKey = playbookInflightKey;

export async function loadOwnedPlaybook(
  store: PlaybookStore,
  id: string,
  userId: string,
): Promise<PlaybookRecord> {
  const pb = await store.get(id);
  if (!pb || pb.userId !== userId) throw new MatchCutError("PLAYBOOK_NOT_FOUND");
  return pb;
}

/**
 * Apply and save need a finished playbook with rules. Running: retryable. Failed or cancelled:
 * not, so clients that retry on `retryable` don't loop.
 */
export function assertApplicable(pb: PlaybookRecord): void {
  if (pb.status === "queued" || pb.status === "processing") {
    throw new MatchCutError("PLAYBOOK_NOT_READY");
  }
  if (pb.status !== "succeeded" || !pb.content) throw new MatchCutError("PLAYBOOK_NOT_AVAILABLE");
  if (pb.content.rules.length === 0) throw new MatchCutError("PLAYBOOK_HAS_NO_RULES");
}

/** Aborts a synchronous model call when the client goes away before the answer. */
export function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const c = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) c.abort(new Error("client disconnected"));
  });
  return c.signal;
}

function send(reply: FastifyReply, pb: PlaybookRecord) {
  const status = isTerminal(pb.status) ? 200 : 202;
  if (status === 202) reply.header("location", `/v1/playbooks/${pb.id}`);
  return reply.status(status).send(toPlaybookResponse(pb));
}

const toChannel = (c: ChannelInfo): PlaybookRecord["channel"] => ({
  id: c.id,
  title: c.title,
  handle: c.handle,
  subscriberCount: c.subscriberCount,
  subscriberCountHidden: c.subscriberCountHidden,
});

export async function playbooksRoutes(app: FastifyInstance, deps: PlaybooksRouteDeps) {
  const { playbooks: store, kv, events } = deps;
  const now = deps.now ?? Date.now;
  const auth = { preHandler: deps.authenticate };

  async function waitFor(id: string): Promise<PlaybookRecord | null> {
    for (let i = 0; i < 20; i++) {
      const p = await store.get(id);
      if (p) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  app.post("/v1/playbooks", auth, async (req, reply) => {
    const { userId, orgId } = req.auth;
    const who = { userId, orgId };

    const idemHeader = req.headers["idempotency-key"];
    const idemKey =
      typeof idemHeader === "string" && idemHeader.length > 0 ? idemHeader : undefined;
    if (idemKey !== undefined && !IDEMPOTENCY_KEY.test(idemKey)) {
      throw new MatchCutError("INVALID_REQUEST");
    }
    const idemStoreKey = idemKey ? `idem:pb:${userId}:${idemKey}` : null;
    if (idemStoreKey) {
      const existingId = await kv.get(idemStoreKey);
      const existing = existingId ? await waitFor(existingId) : null;
      if (existing && existing.userId === userId) return send(reply, existing);
    }

    // As v1, bad input counts toward the limit: a request that fails validation, or names a
    // channel that doesn't exist, still takes a slot.
    const countBadInput = async (e: unknown): Promise<never> => {
      await takeSlot(deps.limiter, "playbook", who);
      throw e;
    };
    let parsedBody: ReturnType<typeof parseCreateBody>;
    try {
      parsedBody = parseCreateBody(req.body);
    } catch (e) {
      return countBadInput(e);
    }
    const { ref, settings, forceRefresh } = parsedBody;
    // PRD: `source.mine` without a connected channel. Own-channel insights are M11.
    if (ref === "mine") throw new MatchCutError("YOUTUBE_NOT_CONNECTED");

    // Resolve now (cached 24 h): an unknown channel fails at once, and the repeat check needs
    // the channel ID. A YouTube outage other than quota leaves it to the worker. Never refreshed
    // here: the worker re-resolves for force_refresh, after the request has taken its slot.
    // At the limit, only a repeat or an attach can succeed, and both follow a recent playbook,
    // so the channel is in the cache: a miss is refused without spending a YouTube call.
    const full = deps.limiter ? await deps.limiter.full("playbook", who) : { ok: true as const };
    const resolved = await deps.channels.resolve(ref, { cacheOnly: !full.ok });
    if (!full.ok && resolved.status === "unavailable" && resolved.reason === "not_cached") {
      throw rateLimited(full);
    }
    if (resolved.status === "not_found")
      return countBadInput(new MatchCutError("CHANNEL_NOT_FOUND"));
    if (resolved.status === "unavailable" && resolved.reason === "quota") {
      throw new MatchCutError("CAPACITY_EXHAUSTED", {}, { source: "youtube", reason: "quota" });
    }
    const channel = resolved.status === "found" ? resolved.channel : null;
    const inflight = channel ? inflightKey(userId, channel.id, settings) : null;

    /**
     * Same user, channel and settings, still running: that job, if any. `wait`: the key may
     * name a playbook another request is creating right now, so give it a moment to appear.
     */
    const runningFor = async (wait = false): Promise<PlaybookRecord | null> => {
      const id = inflight ? await kv.get(inflight) : null;
      const running = id ? await (wait ? waitFor(id) : store.get(id)) : null;
      return running && running.userId === userId && !isTerminal(running.status) ? running : null;
    };
    const remember = async (id: string) => {
      if (idemStoreKey) await kv.set(idemStoreKey, id, IDEMPOTENCY_TTL_SECONDS);
    };

    // Repeats and attaches come before the limit: they start nothing, so they never use a slot
    // (and a user at the limit still gets them).
    if (channel && !forceRefresh) {
      const running = await runningFor();
      if (running) {
        await remember(running.id);
        return send(reply, running);
      }
      const recent = await store.findRecent({
        userId,
        channelId: channel.id,
        settings,
        since: new Date(now() - REPEAT_WINDOW_MS),
      });
      if (recent && !isDegraded(recent)) {
        await remember(recent.id);
        return reply.status(200).send(toPlaybookResponse(recent));
      }
    }

    const slotAt = await takeSlot(deps.limiter, "playbook", who);
    const refund = () => deps.limiter?.refund("playbook", who, slotAt);

    if (deps.spend && (await deps.spend.overCap())) {
      await refund();
      throw new MatchCutError("CAPACITY_EXHAUSTED", {}, { reason: "spend_cap" });
    }

    const record: PlaybookRecord = {
      id: newPlaybookId(),
      userId,
      orgId,
      status: "queued",
      stage: null,
      progress: null,
      source: ref,
      settings,
      forceRefresh,
      channel: channel && toChannel(channel),
      window: null,
      baseline: null,
      notEnoughData: null,
      videos: [],
      comparison: null,
      content: null,
      spokenLines: null,
      warnings: [],
      error: null,
      meta: { models: {}, versions: {}, cached: false, timingsMs: {}, tokens: {} },
      // The slot's time: the worker's refund finds the same rate-limit window.
      createdAt: slotAt,
      updatedAt: slotAt,
    };

    if (idemStoreKey) {
      const claimed = await kv.setIfAbsent(idemStoreKey, record.id, IDEMPOTENCY_TTL_SECONDS);
      if (!claimed) {
        const otherId = await kv.get(idemStoreKey);
        const other = otherId ? await waitFor(otherId) : null;
        if (other && other.userId === userId) {
          await refund();
          return send(reply, other);
        }
        // The key pointed at a playbook that's gone: it now means this one.
        await kv.set(idemStoreKey, record.id, IDEMPOTENCY_TTL_SECONDS);
      }
    }

    // Claim the in-flight slot atomically, so a double click starts one job, not two.
    if (inflight && !forceRefresh) {
      const claimed = await kv.setIfAbsent(inflight, record.id, INFLIGHT_TTL_SECONDS);
      if (!claimed) {
        const running = await runningFor(true);
        if (running) {
          await refund();
          await remember(running.id);
          return send(reply, running);
        }
        await kv.set(inflight, record.id, INFLIGHT_TTL_SECONDS);
      }
    } else if (inflight) {
      await kv.set(inflight, record.id, INFLIGHT_TTL_SECONDS);
    }

    let created = false;
    try {
      await store.create(record);
      created = true;
      await deps.queue.enqueue({ playbookId: record.id });
    } catch (e) {
      req.log.error({ err: (e as Error).message, playbookId: record.id }, "job store unavailable");
      if (created) await store.delete(record.id).catch(() => {});
      if (inflight && (await kv.get(inflight)) === record.id) await kv.del(inflight);
      await refund();
      throw new MatchCutError("INTERNAL", {}, { reason: "job_store_down" });
    }
    return send(reply, record);
  });

  app.get<{ Params: { id: string } }>("/v1/playbooks/:id", auth, async (req) => {
    return toPlaybookResponse(await loadOwnedPlaybook(store, req.params.id, req.auth.userId));
  });

  app.delete<{ Params: { id: string } }>("/v1/playbooks/:id", auth, async (req, reply) => {
    const pb = await loadOwnedPlaybook(store, req.params.id, req.auth.userId);
    if (!isTerminal(pb.status)) {
      // Cancel. Pass 1 and feature caches are kept, as for briefs.
      const cancelled = await store.update(
        pb.id,
        { status: "cancelled", stage: null, progress: null },
        { onlyIfStatus: RUNNING },
      );
      await releasePlaybookInflight(kv, pb);
      // Finished in the meantime: deleting is what the user asked for.
      if (!cancelled) await store.delete(pb.id);
    } else {
      await store.delete(pb.id);
    }
    await events.publish(pb.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/v1/playbooks/:id/events", auth, async (req, reply) => {
    const { id } = req.params;
    const userId = req.auth.userId;
    await loadOwnedPlaybook(store, id, userId);
    await streamEvents(req, reply, {
      id,
      events,
      name: "playbook",
      heartbeatMs: deps.heartbeatMs,
      load: async () => {
        const p = await store.get(id);
        return p && p.userId === userId ? p : null;
      },
      serialize: toPlaybookResponse,
      done: (p) => isTerminal(p.status),
      notFound: () => new MatchCutError("PLAYBOOK_NOT_FOUND").error,
    });
  });

  app.post<{ Params: { id: string } }>("/v1/playbooks/:id/apply", auth, async (req, reply) => {
    const pb = await loadOwnedPlaybook(store, req.params.id, req.auth.userId);
    // Readiness first: a client polling a running playbook doesn't burn its slots.
    assertApplicable(pb);
    const slotAt = await takeSlot(deps.limiter, "regenerate", req.auth);
    const body = parseApplyBody(req.body);
    const content = pb.content!;
    const result = await runApply(
      deps,
      req.auth,
      slotAt,
      {
        type: "recipe",
        recipe: {
          rules: content.rules.map((r) => ({
            feature: r.feature,
            value: r.value,
            title: r.title,
            how_to: r.how_to,
          })),
          houseStyle: content.house_style,
          template: content.recipe_prompt_template,
        },
      },
      body,
      { spokenLines: pb.spokenLines ?? [], spokenFingerprints: [] },
      abortOnDisconnect(reply),
    );
    return reply.status(200).send(result);
  });
}
