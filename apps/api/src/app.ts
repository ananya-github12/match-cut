import cors from "@fastify/cors";
import {
  apiError,
  DEFAULT_LIMITS,
  MatchCutError,
  type CapabilityManifest,
  type Limits,
  type ModelNames,
} from "@match-cut/core";
import type {
  BriefEvents,
  BriefRecord,
  BriefStore,
  JobQueue,
  KV,
  RateLimiter,
  SpendTracker,
} from "@match-cut/infra";
import type { VideoLookup } from "@match-cut/providers";
import Fastify from "fastify";
import { makeAuthenticate } from "./auth.js";
import { runHealthChecks, type HealthChecks } from "./health.js";
import { briefsRoutes } from "./routes/briefs.js";
import { videosRoutes } from "./routes/videos.js";

export interface AppDeps {
  health: HealthChecks;
  lookup: VideoLookup;
  store: BriefStore;
  kv: KV;
  events: BriefEvents;
  queue: JobQueue;
  models: ModelNames;
  manifest: CapabilityManifest;
  devToken: string;
  region?: string;
  limits?: Limits;
  logger?: boolean;
  trustProxy?: boolean;
  webOrigin?: string;
  heartbeatMs?: number;
  limiter?: RateLimiter;
  spend?: SpendTracker;
  syncRun?: (record: BriefRecord) => Promise<BriefRecord>;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: deps.trustProxy ?? false });
  if (deps.webOrigin)
    app.register(cors, { origin: deps.webOrigin, methods: ["GET", "POST", "DELETE"] });

  // Every error leaves as { error: { code, message, retryable } }. Never raw upstream text.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof MatchCutError) {
      const retryAfter = err.detail?.retryAfterSeconds;
      if (typeof retryAfter === "number") reply.header("retry-after", String(retryAfter));
      return reply.status(err.http).send({ error: err.error });
    }
    // Malformed JSON bodies and similar client errors from Fastify itself.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(400).send({ error: apiError("INVALID_REQUEST") });
    }
    req.log.error(err);
    return reply.status(500).send({ error: apiError("INTERNAL") });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply
      .status(404)
      .send({ error: { code: "NOT_FOUND", message: "No such endpoint.", retryable: false } }),
  );

  // Liveness, left open for load balancers; component states say what is reachable.
  app.get("/v1/health", async () => {
    const result = await runHealthChecks(deps.health);
    return { ...result, time: new Date().toISOString() };
  });

  const authenticate = makeAuthenticate(deps.devToken);
  const region = deps.region ?? "US";
  const limits = deps.limits ?? DEFAULT_LIMITS;

  app.register(videosRoutes, { lookup: deps.lookup, region, limits, authenticate });
  app.register(briefsRoutes, {
    store: deps.store,
    kv: deps.kv,
    events: deps.events,
    queue: deps.queue,
    lookup: deps.lookup,
    models: deps.models,
    manifest: deps.manifest,
    heartbeatMs: deps.heartbeatMs,
    limiter: deps.limiter,
    spend: deps.spend,
    syncRun: deps.syncRun,
    region,
    limits,
    authenticate,
  });

  return app;
}
