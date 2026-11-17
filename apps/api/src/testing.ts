/** In-memory app wiring for tests: no Docker, no keys. */
import { loadManifest, modelNames, parseEnv } from "@match-cut/core";
import { MemoryBriefEvents, MemoryBriefStore, MemoryJobQueue, MemoryKV } from "@match-cut/infra";
import { MockVideoLookup } from "@match-cut/providers";
import type { AppDeps } from "./app.js";

export function memoryDeps(over: Partial<AppDeps> = {}): AppDeps {
  const ok = async () => {};
  return {
    health: { database: ok, cache: ok, gemini: async () => "mock" },
    lookup: new MockVideoLookup(),
    store: new MemoryBriefStore(),
    kv: new MemoryKV(),
    events: new MemoryBriefEvents(),
    queue: new MemoryJobQueue(),
    models: modelNames(parseEnv({ DEV_API_TOKEN: "test-token", PROVIDER: "mock" })),
    manifest: loadManifest(),
    devToken: "test-token",
    ...over,
  };
}
