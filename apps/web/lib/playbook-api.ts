/** Browser client for the playbook and skill routes, through the same-origin proxy at /api/mc. */
import type {
  PlaybookResponse,
  SkillResponse,
  SkillSummaryResponse,
} from "@match-cut/core/playbooks/api";
import type { ApplyResponse } from "@match-cut/core/playbooks/apply";
import { ApiFailure } from "./api";

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api/mc/${path}`, { ...init, cache: "no-store" });
  } catch {
    throw new ApiFailure(
      typeof navigator !== "undefined" && !navigator.onLine ? "OFFLINE" : "INTERNAL",
      0,
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ApiFailure(
      body?.error?.code ?? "INTERNAL",
      res.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return res;
}

const post = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

export interface CreatePlaybookBody {
  source: { channel: string };
  window_days?: number;
}

export interface ApplyBody {
  goal?: string;
  target?: { format?: string; length_seconds?: number | null };
  output_language?: string;
}

export async function createPlaybook(body: CreatePlaybookBody, idempotencyKey: string) {
  const res = await call("playbooks", post(body, { "idempotency-key": idempotencyKey }));
  return { status: res.status, playbook: (await res.json()) as PlaybookResponse };
}

export async function getPlaybook(id: string): Promise<PlaybookResponse> {
  return (await call(`playbooks/${id}`)).json();
}

export async function deletePlaybook(id: string): Promise<void> {
  await call(`playbooks/${id}`, { method: "DELETE" });
}

export async function applyPlaybook(id: string, body: ApplyBody): Promise<ApplyResponse> {
  return (await call(`playbooks/${id}/apply`, post(body))).json();
}

export async function saveSkill(name: string, playbookId: string): Promise<SkillResponse> {
  return (await call("skills", post({ name, source: { playbook_id: playbookId } }))).json();
}

export async function listSkills(): Promise<SkillSummaryResponse[]> {
  return ((await (await call("skills")).json()) as { skills: SkillSummaryResponse[] }).skills;
}

export async function deleteSkill(id: string): Promise<void> {
  await call(`skills/${id}`, { method: "DELETE" });
}

export async function applySkill(id: string, body: ApplyBody): Promise<ApplyResponse> {
  return (await call(`skills/${id}/apply`, post(body))).json();
}

export const playbookEventsUrl = (id: string) => `/api/mc/playbooks/${id}/events`;
