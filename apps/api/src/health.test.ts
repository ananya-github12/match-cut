import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { memoryDeps } from "./testing.js";

const base = memoryDeps();

const ok = async () => {};
const fail = async () => {
  throw new Error("connection refused");
};

describe("GET /v1/health", () => {
  it("reports ok when every component is reachable", async () => {
    const app = buildApp({
      ...base,
      health: { database: ok, cache: ok, gemini: async () => "mock" },
    });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      components: { database: "ok", cache: "ok", gemini: "mock" },
    });
  });

  it("stays 200 but reports degraded when a component is down", async () => {
    const app = buildApp({
      ...base,
      health: { database: fail, cache: ok, gemini: async () => "mock" },
    });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "degraded", components: { database: "down" } });
  });

  it("treats a hung check as down", async () => {
    const hang = () => new Promise<void>(() => {});
    const app = buildApp({
      ...base,
      health: { database: ok, cache: hang, gemini: async () => "mock" },
    });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.json()).toMatchObject({ components: { cache: "down" } });
  });
});
