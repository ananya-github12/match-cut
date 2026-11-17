export type ComponentStatus = "ok" | "down" | "mock" | "not_checked";

export interface HealthChecks {
  database: () => Promise<void>;
  cache: () => Promise<void>;
  /** Gemini reachability. Returns "mock" in mock mode; real check lands in M3. */
  gemini: () => Promise<ComponentStatus>;
}

const TIMEOUT_MS = 1500;

async function probe(check: () => Promise<void>): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
      }),
    ]);
    return "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export async function runHealthChecks(checks: HealthChecks) {
  const [database, cache, gemini] = await Promise.all([
    probe(checks.database),
    probe(checks.cache),
    checks.gemini().catch((): ComponentStatus => "down"),
  ]);
  const components = { database, cache, gemini };
  const degraded = Object.values(components).includes("down");
  return { status: degraded ? ("degraded" as const) : ("ok" as const), components };
}
