/** Eval report (JSON + Markdown), the baseline gate, and the human review sheet. */
import type { SetSummary } from "./run.js";
import type { CaseResult, CriterionName } from "./types.js";

export interface RunInfo {
  set: string;
  startedAt: string;
  provider: string;
  judge: string;
  models: { standard: string; deep: string; pass2: string };
  versions: { pass1: string; pass2: string; schema: string; manifest: string };
  targetSize: number;
}

export interface Baseline {
  set: string;
  createdAt: string;
  versions: RunInfo["versions"];
  models: RunInfo["models"];
  criteria: Partial<Record<CriterionName, { passRate: number | null; aggregate?: number }>>;
}

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "n/a" : `${Math.round(v * 100)}%`;
const BAR_TEXT: Record<CriterionName, string> = {
  accuracy: "under 5% of observations wrong",
  specificity: "at least 6 numeric details per breakdown",
  executability: "100% of steps map to the manifest",
  adaptation: "90% of cases adapted",
  originality: "100% original",
  honesty: "reviewer spot-check",
};

/**
 * PRD gate: a change ships only if it matches or beats the current version. Compares pass rates
 * (and accuracy's aggregate wrong rate) against the baseline.
 */
export function gate(
  summary: SetSummary,
  baseline: Baseline | null,
): { ok: boolean; regressions: string[] } {
  if (!baseline) return { ok: true, regressions: [] };
  const regressions: string[] = [];
  for (const [name, base] of Object.entries(baseline.criteria) as [
    CriterionName,
    { passRate: number | null; aggregate?: number },
  ][]) {
    if (name === "honesty") continue;
    const now = summary.criteria[name];
    if (base.passRate !== null && now.passRate !== null && now.passRate < base.passRate - 1e-9) {
      regressions.push(`${name}: ${pct(now.passRate)} < baseline ${pct(base.passRate)}`);
    }
    if (
      name === "accuracy" &&
      base.aggregate !== undefined &&
      now.aggregate !== undefined &&
      now.aggregate > base.aggregate + 1e-9
    ) {
      regressions.push(
        `accuracy wrong rate: ${pct(now.aggregate)} > baseline ${pct(base.aggregate)}`,
      );
    }
  }
  return { ok: regressions.length === 0, regressions };
}

export function toBaseline(info: RunInfo, summary: SetSummary): Baseline {
  return {
    set: info.set,
    createdAt: info.startedAt,
    versions: info.versions,
    models: info.models,
    criteria: Object.fromEntries(
      Object.entries(summary.criteria).map(([k, v]) => [
        k,
        { passRate: v.passRate, ...(v.aggregate !== undefined ? { aggregate: v.aggregate } : {}) },
      ]),
    ),
  };
}

export function markdownReport(
  info: RunInfo,
  summary: SetSummary,
  results: CaseResult[],
  gateResult: { ok: boolean; regressions: string[] } | null,
): string {
  const lines: string[] = [];
  lines.push(`# Match Cut eval: ${info.set}`, "");
  lines.push(`Run ${info.startedAt} · provider **${info.provider}** · judge **${info.judge}**`);
  lines.push(
    `Models: standard ${info.models.standard}, deep ${info.models.deep}, pass 2 ${info.models.pass2}`,
  );
  lines.push(
    `Versions: pass 1 ${info.versions.pass1}, pass 2 ${info.versions.pass2}, schema ${info.versions.schema}, manifest ${info.versions.manifest}`,
  );
  lines.push(
    `Cases: ${summary.scored} scored, ${summary.skipped} skipped, ${summary.errors} errors (set has ${summary.cases} of a target ${info.targetSize}). Estimated cost: $${summary.costUsd.toFixed(3)}.`,
    "",
  );
  if (gateResult) {
    lines.push(
      gateResult.ok
        ? "**Gate: pass** (matches or beats the baseline)"
        : `**Gate: FAIL**\n\n${gateResult.regressions.map((r) => `- ${r}`).join("\n")}`,
      "",
    );
  }
  lines.push("| Criterion | Result | Bar | Meets bar |", "| --- | --- | --- | --- |");
  for (const [name, c] of Object.entries(summary.criteria) as [
    CriterionName,
    SetSummary["criteria"][CriterionName],
  ][]) {
    const result =
      name === "accuracy" ? `${pct(c.aggregate)} wrong` : `${pct(c.passRate)} of ${c.scored}`;
    const meets =
      c.meetsBar === null ? (name === "honesty" ? "review" : "n/a") : c.meetsBar ? "yes" : "**no**";
    lines.push(`| ${name} | ${result} | ${BAR_TEXT[name]} | ${meets} |`);
  }
  lines.push(
    "",
    "## Cases",
    "",
    "| Case | Category | Status | Acc. | Spec. | Exec. | Adapt. | Orig. | Honesty flags | Repairs |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of results) {
    if (r.status !== "scored") {
      lines.push(`| ${r.id} | ${r.category} | ${r.status}: ${r.skip ?? r.error} | | | | | | | |`);
      continue;
    }
    const c = r.criteria!;
    const mark = (x: { pass: boolean | null }) => (x.pass === null ? "n/a" : x.pass ? "✓" : "✗");
    lines.push(
      `| ${r.id} | ${r.category} | scored | ${mark(c.accuracy)} ${c.accuracy.value !== undefined ? pct(c.accuracy.value) : ""} | ${mark(c.specificity)} ${c.specificity.value} | ${mark(c.executability)} | ${mark(c.adaptation)} | ${mark(c.originality)} | ${c.honesty.pass ? "" : c.honesty.detail} | ${[r.repairs?.pass1 ? "p1" : "", r.repairs?.pass2 ? "p2" : ""].filter(Boolean).join(", ")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** PRD: human review of 10 random briefs each week and of every failed criterion. */
export function reviewSheet(
  results: CaseResult[],
  sampleSize = 10,
  rand: () => number = Math.random,
): string {
  const scored = results.filter((r) => r.status === "scored");
  const failed = scored.filter((r) => Object.values(r.criteria!).some((c) => c.pass === false));
  const pool = scored.filter((r) => !failed.includes(r));
  const sample = [...pool]
    .sort(() => rand() - 0.5)
    .slice(0, Math.max(0, sampleSize - failed.length));
  const lines = [
    "# Human review",
    "",
    "Mark each item. Confirm or overturn the judge; note anything it missed.",
    "",
  ];
  for (const r of [...failed, ...sample]) {
    lines.push(
      `## ${r.id} (${r.category})${failed.includes(r) ? " — failed a criterion" : " — random sample"}`,
      "",
    );
    for (const [name, c] of Object.entries(r.criteria!)) {
      if (c.pass === false || name === "honesty")
        lines.push(`- [ ] **${name}**: ${c.detail ?? ""}`);
    }
    for (const n of r.judgeNotes ?? []) lines.push(`- [ ] contradicted observation: ${n}`);
    lines.push(
      "- [ ] Prompt reads as an original edit plan for the user's goal",
      "",
      "<details><summary>Prompt</summary>",
      "",
      "```",
      r.prompt ?? "",
      "```",
      "</details>",
      "",
    );
  }
  return lines.join("\n");
}
