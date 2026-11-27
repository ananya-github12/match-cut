import cors from "@fastify/cors";
import {
  apiError,
  DEFAULT_LIMITS,
  MatchCutError,
  type CapabilityManifest,
  type Limits,
  type ModelNames,
  type Pricing,
} from "@match-cut/core";
import type {
  BriefEvents,
  BriefRecord,
  BriefStore,
  JobQueue,
  KV,
  PlaybookJobQueue,
  PlaybookStore,
  RateLimiter,
  SkillStore,
  SpendTracker,
} from "@match-cut/infra";
import type { ChannelLookup, VideoAnalyzer, VideoLookup } from "@match-cut/providers";
import Fastify from "fastify";
import { makeAuthenticate } from "./auth.js";
import { runHealthChecks, type HealthChecks } from "./health.js";
import { mcpRoutes } from "./mcp/route.js";
import type { McpToolOptions } from "./mcp/tools.js";
import { briefsRoutes } from "./routes/briefs.js";
import { playbooksRoutes } from "./routes/playbooks.js";
import { skillsRoutes } from "./routes/skills.js";
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
  /** Match Cut MCP server at /mcp. Off when no keys are given. */
  mcp?: McpToolOptions & { keys: string[] };
  /** Playbooks and saved skills (PRD-playbooks.md, M10). Off when not given. */
  playbooks?: {
    store: PlaybookStore;
    skills: SkillStore;
    queue: PlaybookJobQueue;
    channels: ChannelLookup;
    /** For apply: the text step that writes a prompt and shot list. */
    analyzer: VideoAnalyzer;
    pricing?: Pricing;
  };
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
  if (deps.playbooks) {
    const pb = deps.playbooks;
    const applyDeps = {
      kv: deps.kv,
      analyzer: pb.analyzer,
      models: deps.models,
      manifest: deps.manifest,
      limiter: deps.limiter,
      spend: deps.spend,
      pricing: pb.pricing,
    };
    app.register(playbooksRoutes, {
      ...applyDeps,
      playbooks: pb.store,
      events: deps.events,
      queue: pb.queue,
      channels: pb.channels,
      authenticate,
      heartbeatMs: deps.heartbeatMs,
    });
    app.register(skillsRoutes, {
      ...applyDeps,
      skills: pb.skills,
      briefs: deps.store,
      playbooks: pb.store,
      authenticate,
    });
  }
  app.register(mcpRoutes, {
    ...deps.mcp,
    keys: deps.mcp?.keys ?? [],
    devToken: deps.devToken,
    playbooks: deps.playbooks !== undefined,
  });

  return app;
}
