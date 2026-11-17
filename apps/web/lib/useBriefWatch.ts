"use client";
/**
 * Follows a running brief. PRD "Data fetching":
 * - stream stage updates with server-sent events;
 * - on stream error, poll GET /v1/briefs/{id} every 2 s for the first 30 s, then every 4 s;
 * - stop after 5 minutes and report a timeout;
 * - pause while offline and resume on reconnect; check again when the page wakes up
 *   (tab visible again, or the Mac app waking from sleep).
 */
import type { BriefResponse } from "@match-cut/core/schemas";
import { useEffect, useRef, useState } from "react";
import { ApiFailure, eventsUrl, getBrief } from "./api";

const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled"]);
export const POLL_FAST_MS = 2000;
export const POLL_SLOW_MS = 4000;
export const POLL_FAST_FOR_MS = 30_000;
export const GIVE_UP_AFTER_MS = 5 * 60_000;

export type Connection = "idle" | "stream" | "polling" | "offline";

export function useBriefWatch(
  briefId: string | null,
  onUpdate: (brief: BriefResponse) => void,
  onGone: (code: string) => void,
  /** Bump to follow the same brief again (after Regenerate). */
  nonce = 0,
) {
  const [connection, setConnection] = useState<Connection>("idle");
  const [timedOut, setTimedOut] = useState(false);
  const cb = useRef({ onUpdate, onGone });
  cb.current = { onUpdate, onGone };

  useEffect(() => {
    if (!briefId) return;
    let stopped = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let pollingSince = 0;
    setTimedOut(false);

    const finish = () => {
      stopped = true;
      es?.close();
      clearTimeout(timer);
      setConnection("idle");
    };
    const handle = (b: BriefResponse) => {
      if (stopped) return;
      cb.current.onUpdate(b);
      if (TERMINAL.has(b.status)) finish();
    };
    const check = async () => {
      try {
        handle(await getBrief(briefId));
      } catch (e) {
        if (e instanceof ApiFailure && (e.code === "BRIEF_NOT_FOUND" || e.status === 404)) {
          finish();
          cb.current.onGone(e.code);
        }
      }
    };

    const poll = () => {
      if (stopped) return;
      if (Date.now() - started > GIVE_UP_AFTER_MS) {
        finish();
        setTimedOut(true);
        return;
      }
      if (!navigator.onLine) {
        setConnection("offline");
        return; // resumed by the online listener
      }
      setConnection("polling");
      void check().finally(() => {
        if (stopped) return;
        const fast = Date.now() - pollingSince < POLL_FAST_FOR_MS;
        timer = setTimeout(poll, fast ? POLL_FAST_MS : POLL_SLOW_MS);
      });
    };

    const startPolling = () => {
      es?.close();
      es = null;
      if (!pollingSince) pollingSince = Date.now();
      clearTimeout(timer);
      poll();
    };

    const stream = () => {
      if (stopped) return;
      if (!navigator.onLine) {
        setConnection("offline");
        return;
      }
      setConnection("stream");
      es = new EventSource(eventsUrl(briefId));
      es.addEventListener("brief", (ev) => handle(JSON.parse((ev as MessageEvent).data)));
      es.addEventListener("error", (ev) => {
        // A server-sent "error" event carries data; a connection error doesn't.
        const data = (ev as MessageEvent).data;
        if (data) {
          finish();
          cb.current.onGone(JSON.parse(data).code ?? "BRIEF_NOT_FOUND");
          return;
        }
        if (!stopped) startPolling();
      });
    };

    const onOffline = () => {
      if (stopped) return;
      es?.close();
      es = null;
      clearTimeout(timer);
      setConnection("offline");
    };
    const onOnline = () => {
      if (stopped) return;
      void check().then(() => {
        if (!stopped) (pollingSince ? startPolling : stream)();
      });
    };
    const onWake = () => {
      if (!stopped && document.visibilityState === "visible") void check();
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    stream();

    return () => {
      finish();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [briefId, nonce]);

  return { connection, timedOut };
}
