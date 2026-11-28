"use client";
/**
 * Follows a running playbook, as useBriefWatch follows a brief: server-sent events first, then
 * polling (every 2 s for 30 s, then every 4 s) if the stream drops; pauses while offline and
 * checks again when the page wakes. Playbooks watch up to 10 videos, so the give-up time is the
 * worker's own limit (10 minutes) plus a margin.
 */
import type { PlaybookResponse } from "@match-cut/core/playbooks/api";
import { useEffect, useRef, useState } from "react";
import { ApiFailure } from "./api";
import { getPlaybook, playbookEventsUrl } from "./playbook-api";
import { POLL_FAST_FOR_MS, POLL_FAST_MS, POLL_SLOW_MS, type Connection } from "./useBriefWatch";

const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled"]);
export const PLAYBOOK_GIVE_UP_AFTER_MS = 12 * 60_000;

export function usePlaybookWatch(
  playbookId: string | null,
  onUpdate: (p: PlaybookResponse) => void,
  onGone: (code: string) => void,
) {
  const [connection, setConnection] = useState<Connection>("idle");
  const [timedOut, setTimedOut] = useState(false);
  const cb = useRef({ onUpdate, onGone });
  cb.current = { onUpdate, onGone };

  useEffect(() => {
    // A new playbook, or none: whatever timed out before no longer applies.
    setTimedOut(false);
    if (!playbookId) return;
    let stopped = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let pollingSince = 0;

    const finish = () => {
      stopped = true;
      es?.close();
      clearTimeout(timer);
      setConnection("idle");
    };
    const handle = (p: PlaybookResponse) => {
      if (stopped) return;
      cb.current.onUpdate(p);
      if (TERMINAL.has(p.status)) finish();
    };
    const check = async () => {
      try {
        handle(await getPlaybook(playbookId));
      } catch (e) {
        // A late answer for a playbook this hook no longer follows must not clear a newer one.
        if (stopped) return;
        if (e instanceof ApiFailure && (e.code === "PLAYBOOK_NOT_FOUND" || e.status === 404)) {
          finish();
          cb.current.onGone(e.code);
        }
      }
    };
    const poll = () => {
      if (stopped) return;
      if (Date.now() - started > PLAYBOOK_GIVE_UP_AFTER_MS) {
        finish();
        setTimedOut(true);
        return;
      }
      if (!navigator.onLine) {
        setConnection("offline");
        return;
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
      es = new EventSource(playbookEventsUrl(playbookId));
      es.addEventListener("playbook", (ev) => handle(JSON.parse((ev as MessageEvent).data)));
      es.addEventListener("error", (ev) => {
        const data = (ev as MessageEvent).data;
        if (data) {
          const code = (JSON.parse(data) as { code?: string }).code ?? "PLAYBOOK_NOT_FOUND";
          // The stream can end with an error event (e.g. live updates unavailable): fall back
          // to polling unless the playbook itself is gone.
          if (code === "PLAYBOOK_NOT_FOUND") {
            finish();
            cb.current.onGone(code);
            return;
          }
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
  }, [playbookId]);

  return { connection, timedOut };
}
