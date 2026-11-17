import { buildApp, type AppDeps } from "@match-cut/api/app";
import { memoryDeps } from "@match-cut/api/testing";
import type { BriefResponse } from "@match-cut/core";
import { MemoryJobQueue, type JobData } from "@match-cut/infra";
import {
  MockAnalyzer,
  MockVideoLookup,
  type VideoAnalyzer,
  type VideoLookup,
} from "@match-cut/providers";
import { runJob, type PipelineDeps } from "@match-cut/worker/pipeline";

export const AUTH = { authorization: "Bearer test-token" };

/** API + pipeline wired in memory. `autoRun` runs each queued job right away. */
export function harness(
  opts: {
    autoRun?: boolean;
    analyzer?: VideoAnalyzer;
    app?: Partial<AppDeps>;
    pipeline?: Partial<PipelineDeps>;
    pipelineLookup?: VideoLookup;
  } = {},
) {
  const queue = new MemoryJobQueue();
  const deps = memoryDeps({ queue, ...opts.app });
  const analyzer = opts.analyzer ?? new MockAnalyzer();
  const pipeline: PipelineDeps = {
    store: deps.store,
    kv: deps.kv,
    events: deps.events,
    analyzer,
    manifest: deps.manifest,
    models: deps.models,
    lookup: opts.pipelineLookup ?? new MockVideoLookup(),
    ...opts.pipeline,
  };
  const running = new Set<Promise<void>>();
  const run = (job: JobData) => {
    const p = runJob(job, pipeline).finally(() => running.delete(p));
    running.add(p);
    return p;
  };
  if (opts.autoRun ?? true) queue.onEnqueue = (job) => void run(job);
  const app = buildApp(deps);

  return {
    app,
    deps,
    queue,
    analyzer,
    /** Runs every job queued so far that hasn't run. */
    async drain() {
      const jobs = queue.jobs.splice(0);
      await Promise.all(jobs.map(run));
    },
    async idle() {
      while (running.size) await Promise.all([...running]);
    },
    post(body: unknown, headers: Record<string, string> = {}) {
      return app.inject({
        method: "POST",
        url: "/v1/briefs",
        payload: body as object,
        headers: { ...AUTH, ...headers },
      });
    },
    get(id: string, headers: Record<string, string> = AUTH) {
      return app.inject({ method: "GET", url: `/v1/briefs/${id}`, headers });
    },
    async brief(id: string): Promise<BriefResponse> {
      return (await this.get(id)).json();
    },
    regenerate(id: string, body: unknown) {
      return app.inject({
        method: "POST",
        url: `/v1/briefs/${id}/regenerate`,
        payload: body as object,
        headers: AUTH,
      });
    },
    del(id: string) {
      return app.inject({ method: "DELETE", url: `/v1/briefs/${id}`, headers: AUTH });
    },
  };
}
