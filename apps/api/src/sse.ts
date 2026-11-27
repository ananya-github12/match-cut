/**
 * Server-sent events for a job (PRD: "clients stream stage events or poll"). Each change pushes
 * the full object as one named event; pushes are chained so they stay in order, unchanged objects
 * aren't re-sent, and the stream closes when the job finishes.
 */
import type { BriefEvents } from "@match-cut/infra";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface SseOptions<T> {
  id: string;
  events: BriefEvents;
  /** The event name ("brief", "playbook"). */
  name: string;
  /** The caller's current view, or null when it's gone or not theirs. */
  load: () => Promise<T | null>;
  serialize: (value: T) => unknown;
  done: (value: T) => boolean;
  /** The error body sent when the object disappears. */
  notFound: () => { code: string; message: string; retryable: boolean };
  heartbeatMs?: number;
}

export async function streamEvents<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  o: SseOptions<T>,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let closed = false;
  let chain = Promise.resolve();
  const subscription: { off?: () => Promise<void> } = {};
  const heartbeat = setInterval(() => res.write(": ping\n\n"), o.heartbeatMs ?? 15000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    void subscription.off?.().catch(() => {});
    res.end();
  };
  req.raw.on("close", close);

  let lastSent = "";
  const push = () => {
    chain = chain
      .then(async () => {
        if (closed) return;
        const value = await o.load();
        if (!value) {
          res.write(`event: error\ndata: ${JSON.stringify(o.notFound())}\n\n`);
          return close();
        }
        const data = JSON.stringify(o.serialize(value));
        if (data !== lastSent) {
          res.write(`event: ${o.name}\ndata: ${data}\n\n`);
          lastSent = data;
        }
        if (o.done(value)) close();
      })
      // A failed read skips one update; the next change (or the heartbeat's client) retries.
      .catch(() => {});
  };

  // Subscribe before the first snapshot so no change is missed in between.
  subscription.off = await o.events.subscribe(o.id, push);
  if (closed) await subscription.off();
  push();
}
