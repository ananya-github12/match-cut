/** Cost per call from token counts. Server-only. Unknown models use the (high) default price. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { workspaceRoot } from "./manifest.js";

const price = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() });
const pricingSchema = z.object({
  models: z.record(z.string(), price.passthrough()),
  default: price,
});
export type Pricing = z.infer<typeof pricingSchema>;

export function loadPricing(path?: string): Pricing {
  const file = path ?? join(workspaceRoot(process.cwd()), "config", "pricing.json");
  return pricingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function costUsd(
  pricing: Pricing,
  model: string,
  tokens: { input: number; output: number },
): number {
  const p = pricing.models[model] ?? pricing.default;
  return (tokens.input * p.input + tokens.output * p.output) / 1_000_000;
}
