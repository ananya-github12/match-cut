/**
 * PRD "Analytics events". Every event carries brief_id (once known), project_id, platform and
 * entry_point. In dev, events go to the console and to window.__matchCutEvents (for tests).
 */
export type Platform = "web" | "mac" | "mobile_web";
export type EntryPoint = "paste_card" | "chat_action" | "slash_command" | "director" | "deep_link";

export type EventName =
  | "match_opened"
  | "link_validated"
  | "brief_requested"
  | "brief_succeeded"
  | "brief_partial"
  | "brief_failed"
  | "brief_cancelled"
  | "prompt_edited"
  | "prompt_copied"
  | "prompt_sent_to_director"
  | "prompt_regenerated"
  | "beat_clicked"
  | "shot_list_viewed"
  | "brief_feedback"
  | "brief_deleted";

export interface EventContext {
  project_id: string;
  platform: Platform;
  entry_point: EntryPoint;
  brief_id?: string;
}

declare global {
  interface Window {
    __matchCutEvents?: { name: EventName; props: Record<string, unknown> }[];
  }
}

export function track(name: EventName, ctx: EventContext, props: Record<string, unknown> = {}) {
  const payload = { ...props, ...ctx };
  if (typeof window !== "undefined") {
    (window.__matchCutEvents ??= []).push({ name, props: payload });
  }
  // Dev sink. A real build would send these to Cardboard's analytics pipeline.
  console.info("[analytics]", name, payload);
}

export function detectPlatform(): Platform {
  if (typeof window === "undefined") return "web";
  const ua = navigator.userAgent;
  if (/CardboardDesktop|Electron/i.test(ua)) return "mac";
  if (window.matchMedia("(max-width: 767px) and (pointer: coarse)").matches) return "mobile_web";
  return "web";
}
