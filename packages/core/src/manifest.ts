/** Capability manifest loading. Server-only. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const manifestSchema = z.object({
  manifest_version: z.string().min(1),
  operations: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string(),
        options: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});
export type CapabilityManifest = z.infer<typeof manifestSchema>;

export function workspaceRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Reads the manifest from `path`, or config/capability-manifest.v0.json at the workspace root. */
export function loadManifest(path?: string): CapabilityManifest {
  const file = path ?? join(workspaceRoot(process.cwd()), "config", "capability-manifest.v0.json");
  return manifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
