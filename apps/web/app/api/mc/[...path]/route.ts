/**
 * Same-origin proxy to the Match Cut API. It stands in for Cardboard's session: the browser never
 * holds a token, and server-sent events work with the browser's EventSource. It forwards only
 * /v1/briefs, /v1/videos, /v1/playbooks and /v1/skills routes, so it can't reach anything else.
 * PRD: "Never call Gemini or the YouTube Data API from the client."
 *
 * Each browser gets an anonymous visitor ID (HTTP-only cookie), sent to the API as the user, so
 * visitors to a public demo have their own briefs and their own rate limits.
 *
 * Deployed on Vercel with services (vercel.json): the "api" binding injects MATCH_CUT_API_URL at
 * runtime, and the token is the project's DEV_API_TOKEN, shared by every service.
 * Web on Vercel with the API elsewhere (e.g. Railway): set MATCH_CUT_API_URL and
 * MATCH_CUT_API_TOKEN (same value as the API's DEV_API_TOKEN).
 * Locally, both fall back to the workspace .env.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Event streams stay open while a job runs; past this the client falls back to polling.
export const maxDuration = 300;

const ALLOWED =
  /^(briefs(\/[A-Za-z0-9_]+(\/(events|regenerate))?)?|videos\/[A-Za-z0-9_-]{11}|playbooks(\/[A-Za-z0-9_]+(\/(events|apply))?)?|skills(\/[A-Za-z0-9_]+(\/apply)?)?)$/;
const PASS_REQUEST = ["content-type", "idempotency-key", "accept"];
const PASS_RESPONSE = ["content-type", "retry-after", "cache-control", "location"];
const VISITOR_COOKIE = "mc_visitor";
const VISITOR_ID = /^v_[0-9a-f]{32}$/;

async function config(): Promise<{ url: string; token: string }> {
  const url = process.env.MATCH_CUT_API_URL;
  // Read per request, never at build time: service bindings resolve at runtime only.
  const token = process.env.MATCH_CUT_API_TOKEN || process.env.DEV_API_TOKEN;
  if (url && token) return { url: url.replace(/\/$/, ""), token };
  // Local development: read the workspace .env (never needed in a deployment).
  const { loadEnv } = await import("@match-cut/core");
  const env = loadEnv();
  return { url: url ?? `http://127.0.0.1:${env.API_PORT}`, token: token ?? env.DEV_API_TOKEN };
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message, retryable: status >= 500 } }, { status });
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const sub = path.join("/");
  if (!ALLOWED.test(sub)) return errorResponse(404, "NOT_FOUND", "No such endpoint.");

  const existing = req.cookies.get(VISITOR_COOKIE)?.value;
  const visitor =
    existing && VISITOR_ID.test(existing) ? existing : `v_${randomUUID().replace(/-/g, "")}`;

  const { url, token } = await config();
  const headers = new Headers({ authorization: `Bearer ${token}`, "x-dev-user-id": visitor });
  for (const h of PASS_REQUEST) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${url}/v1/${sub}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.text(),
      signal: req.signal,
      cache: "no-store",
    });
  } catch {
    return errorResponse(502, "INTERNAL", "Something went wrong while analyzing.");
  }
  const out = new Headers();
  for (const h of PASS_RESPONSE) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (sub.endsWith("/events")) out.set("x-accel-buffering", "no");
  if (existing !== visitor) {
    const secure = req.nextUrl.protocol === "https:" ? "; Secure" : "";
    out.append(
      "set-cookie",
      `${VISITOR_COOKIE}=${visitor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
    );
  }
  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

export { proxy as DELETE, proxy as GET, proxy as POST };
