/**
 * LLM judge (PRD: "Scoring uses an LLM judge with the rubric above"). Text only: it compares the
 * breakdown with the human reference facts, maps each prompt step to a manifest operation, and
 * rates adaptation, originality and honesty. MockJudge gives deterministic answers for tests.
 */
import type { Breakdown, CapabilityManifest } from "@match-cut/core";
import { manifestText } from "@match-cut/core";
import { GoogleGenAI } from "@google/genai";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { adaptationChecks, mapStepsToOperations, observationTexts } from "./score.js";
import type { EvalCase, Reference } from "./types.js";

export interface JudgeInput {
  evalCase: EvalCase;
  reference: Reference | null;
  breakdown: Breakdown;
  prompt: string;
  manifest: CapabilityManifest;
}

export const judgeResultSchema = z.object({
  observations: z.array(
    z.object({
      field: z.string(),
      verdict: z.enum(["consistent", "contradicted", "unverifiable"]),
      reason: z.string(),
    }),
  ),
  steps: z.array(
    z.object({ step: z.number(), operation: z.string().nullable(), reason: z.string() }),
  ),
  adapted: z.boolean(),
  adaptation_reason: z.string(),
  copied: z.array(z.string()),
  invented: z.array(z.string()),
});
export type JudgeResult = z.infer<typeof judgeResultSchema>;

export interface Judge {
  readonly name: string;
  evaluate(input: JudgeInput): Promise<JudgeResult>;
}

const RUBRIC = readFileSync(new URL("../RUBRIC.md", import.meta.url), "utf8");

export const JUDGE_INSTRUCTION = `You grade the output of a video-analysis system against a rubric. Be strict and literal. You never see the video; judge only from the human reference facts and the texts given.

${RUBRIC}

Return JSON with:
- observations: for EVERY observation listed under "Breakdown observations", one verdict: "consistent" if a reference fact supports it, "contradicted" if a reference fact says otherwise, "unverifiable" if the facts don't cover it. If no reference is given, mark every observation "unverifiable".
- steps: for every numbered prompt step, the manifest operation id it needs, or null if no listed operation can do it.
- adapted: true if the prompt is about the user's goal (not the reference's topic) and handles the target format and length.
- copied: any phrases in the prompt that look copied from the reference's script, lyrics, brand names or catchphrases (from the reference's brand terms).
- invented: claims in the breakdown that the reference says are absent (for example music when the reference says there is none), or confident specifics where "unclear" would be honest.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          verdict: { type: "string", enum: ["consistent", "contradicted", "unverifiable"] },
          reason: { type: "string" },
        },
        required: ["field", "verdict", "reason"],
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "number" },
          operation: { anyOf: [{ type: "string" }, { type: "null" }] },
          reason: { type: "string" },
        },
        required: ["step", "operation", "reason"],
      },
    },
    adapted: { type: "boolean" },
    adaptation_reason: { type: "string" },
    copied: { type: "array", items: { type: "string" } },
    invented: { type: "array", items: { type: "string" } },
  },
  required: ["observations", "steps", "adapted", "adaptation_reason", "copied", "invented"],
} as const;

export function judgeUserText(i: JudgeInput): string {
  const obs = observationTexts(i.breakdown)
    .map((o) => `- [${o.field}] ${o.text}`)
    .join("\n");
  const ref = i.reference
    ? `Human reference facts:\n${i.reference.facts.map((f) => `- ${f}`).join("\n")}\n` +
      `Reference signals: speech=${i.reference.has_speech ?? "?"}, music=${i.reference.has_music ?? "?"}, person on camera=${i.reference.has_on_camera_person ?? "?"}, aspect=${i.reference.aspect_ratio ?? "?"}\n` +
      `Brand terms that must not be copied: ${i.reference.brand_terms.join("; ") || "(none)"}`
    : "No human reference is available.";
  return `${ref}

Breakdown signals: ${JSON.stringify(i.breakdown.signals)}; aspect ${i.breakdown.format.aspect_ratio}; duration ${i.breakdown.format.duration}.
Breakdown observations:
${obs}

User's goal: ${i.evalCase.goal}
Target format: ${i.evalCase.target.format}; target length: ${i.evalCase.target.length_seconds ?? "same as reference"} seconds; language: ${i.evalCase.language}.

Capability manifest:
${manifestText(i.manifest)}

Prompt to grade:
${i.prompt}`;
}

export class GeminiJudge implements Judge {
  readonly name: string;
  private readonly ai: GoogleGenAI;
  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.name = `gemini:${model}`;
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 2 } } });
  }
  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: judgeUserText(input) }] }],
      config: {
        systemInstruction: JUDGE_INSTRUCTION,
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: JUDGE_SCHEMA,
        maxOutputTokens: 8192,
        httpOptions: { timeout: 120_000 },
      },
    });
    return judgeResultSchema.parse(JSON.parse(res.text ?? "{}"));
  }
}

const numbers = (s: string) => new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));

/**
 * Deterministic stand-in for tests and offline runs. Accuracy: an observation is consistent when
 * it shares a number or three content words with a fact, contradicted when the signals disagree
 * with the reference, otherwise unverifiable.
 */
export class MockJudge implements Judge {
  readonly name = "mock";
  async evaluate(i: JudgeInput): Promise<JudgeResult> {
    const facts = i.reference?.facts ?? [];
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const observations = observationTexts(i.breakdown).map((o) => {
      const on = numbers(o.text);
      const ow = words(o.text);
      const match = facts.find((f) => {
        const fnums = [...numbers(f)];
        const shared = [...words(f)].filter((w) => ow.has(w)).length;
        return fnums.some((n) => on.has(n)) || shared >= 3;
      });
      return {
        field: o.field,
        verdict: (match ? "consistent" : "unverifiable") as "consistent" | "unverifiable",
        reason: match ? `matches "${match}"` : "not covered by the facts",
      };
    });
    const invented: string[] = [];
    const r = i.reference;
    const s = i.breakdown.signals;
    if (r?.has_music === false && s.has_music)
      invented.push("claims music; the reference says there is none");
    if (r?.has_speech === false && s.has_speech)
      invented.push("claims speech; the reference says there is none");
    if (r?.has_on_camera_person === false && s.has_on_camera_person)
      invented.push("claims a person on camera");
    if (invented.length) {
      observations.push({
        field: "signals",
        verdict: "contradicted" as never,
        reason: invented.join("; "),
      });
    }
    const adaptation = adaptationChecks(i.prompt, i.evalCase, i.breakdown);
    return {
      observations,
      steps: mapStepsToOperations(i.prompt, i.manifest).map((st) => ({
        step: st.step,
        operation: st.operation,
        reason: st.operation ? "keyword match" : "no operation matched",
      })),
      adapted: adaptation.pass,
      adaptation_reason: adaptation.pass
        ? "goal, format and length handled"
        : adaptation.failed.join("; "),
      copied: [],
      invented,
    };
  }
}
