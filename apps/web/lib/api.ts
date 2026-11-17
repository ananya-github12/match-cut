/** Browser client for the Match Cut API, through the same-origin proxy at /api/mc. */
import type { BriefResponse } from "@match-cut/core/schemas";

export type ErrorCodeLike = string;

export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCodeLike,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export interface VideoPreview {
  id: string;
  precheck: "ok" | "skipped";
  video: {
    id: string;
    title: string;
    channel: string;
    thumbnail_url: string | null;
    duration_seconds: number;
    embeddable: boolean;
  } | null;
  blocking_error: { code: string; message: string; retryable: boolean } | null;
  requires_clip_range: boolean;
  warnings: { code: string; message: string }[];
}

export interface CreateBody {
  source: { url: string };
  goal?: string;
  target?: { format?: string; length_seconds?: number };
  clip?: { start_seconds?: number; end_seconds?: number };
  output_language?: string;
  detail?: "standard" | "deep";
}

export interface RegenerateBody {
  goal?: string;
  target?: { format?: string; length_seconds?: number | null };
  output_language?: string;
}

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

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

export async function createBrief(body: CreateBody, idempotencyKey: string) {
  const res = await call("briefs", json(body, { "idempotency-key": idempotencyKey }));
  return { status: res.status, brief: (await res.json()) as BriefResponse };
}

export async function getBrief(id: string): Promise<BriefResponse> {
  return (await call(`briefs/${id}`)).json();
}

export async function regenerateBrief(id: string, body: RegenerateBody) {
  const res = await call(`briefs/${id}/regenerate`, json(body));
  return { status: res.status, brief: (await res.json()) as BriefResponse };
}

export async function deleteBrief(id: string): Promise<void> {
  await call(`briefs/${id}`, { method: "DELETE" });
}

export async function getVideo(id: string, signal?: AbortSignal): Promise<VideoPreview> {
  return (await call(`videos/${id}`, { signal })).json();
}

export const eventsUrl = (id: string) => `/api/mc/briefs/${id}/events`;

export function newIdempotencyKey(): string {
  return `mc-${crypto.randomUUID()}`;
}
