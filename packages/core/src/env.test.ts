import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("runs in mock mode with no API keys", () => {
    const env = parseEnv({ DEV_API_TOKEN: "t" });
    expect(env.PROVIDER).toBe("mock");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.API_PORT).toBe(4000);
    expect(env.DAILY_SPEND_CAP_USD).toBe(5);
  });

  it("treats blank values as unset", () => {
    const env = parseEnv({ DEV_API_TOKEN: "t", GEMINI_API_KEY: "  " });
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("requires a dev token", () => {
    expect(() => parseEnv({})).toThrow(/DEV_API_TOKEN/);
  });

  it("lists every missing key when PROVIDER=gemini", () => {
    try {
      parseEnv({ DEV_API_TOKEN: "t", PROVIDER: "gemini", GEMINI_API_KEY: "k" });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toMatch(/GEMINI_API_KEY/);
      for (const key of [
        "YOUTUBE_DATA_API_KEY",
        "GEMINI_MODEL_STANDARD",
        "GEMINI_MODEL_DEEP",
        "GEMINI_MODEL_FALLBACK",
      ]) {
        expect(msg).toContain(key);
      }
    }
  });

  it("rejects an unknown provider and a bad spend cap", () => {
    expect(() => parseEnv({ DEV_API_TOKEN: "t", PROVIDER: "openai" })).toThrow(/PROVIDER/);
    expect(() => parseEnv({ DEV_API_TOKEN: "t", DAILY_SPEND_CAP_USD: "-1" })).toThrow(
      /DAILY_SPEND_CAP_USD/,
    );
  });
});
