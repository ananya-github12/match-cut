/**
 * Auth stub standing in for Cardboard sessions and Director service tokens.
 * `Authorization: Bearer <DEV_API_TOKEN>`. `X-Dev-User-Id` / `X-Dev-Org-Id` simulate other users
 * in tests and demos. Swap this module for real session verification when integrating.
 */
import { timingSafeEqual } from "node:crypto";
import { MatchCutError } from "@match-cut/core";
import type { FastifyRequest } from "fastify";

export interface AuthContext {
  userId: string;
  orgId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const ID_HEADER = /^[A-Za-z0-9_-]{1,64}$/;

export function makeAuthenticate(devToken: string) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !safeEqual(token, devToken)) throw new MatchCutError("UNAUTHORIZED");
    const user = req.headers["x-dev-user-id"];
    const org = req.headers["x-dev-org-id"];
    req.auth = {
      userId: typeof user === "string" && ID_HEADER.test(user) ? user : "dev-user",
      orgId: typeof org === "string" && ID_HEADER.test(org) ? org : "dev-org",
    };
  };
}
