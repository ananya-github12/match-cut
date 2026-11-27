/**
 * POST /mcp: Match Cut's remote MCP server (Streamable HTTP, stateless: one server per request).
 *
 * Access needs an API key from MCP_API_KEYS, sent as `Authorization: Bearer <key>` (Claude's
 * custom connectors send fixed request headers). Each key acts as its own user, so its briefs,
 * rate limits and history are separate. With no keys configured the endpoint is off.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildMcpServer, type ApiResult, type MatchCutApi, type McpToolOptions } from "./tools.js";

export interface McpRouteOptions extends McpToolOptions {
  keys: string[];
  /** Used to call the /v1 routes in-process on behalf of the key's user. */
  devToken: string;
  /** Playbook and skill routes are registered: offer their tools too. */
  playbooks?: boolean;
}

/** Org every MCP user belongs to, so connector use has its own org-wide limit. */
export const MCP_ORG_ID = "mcp";

/** Stable, non-reversible user ID for a key. */
export function mcpUserId(key: string): string {
  return `mcp_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function sameText(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function keyFrom(req: FastifyRequest, keys: string[]): string | undefined {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return undefined;
  return keys.find((k) => sameText(k, token));
}

function rpcError(reply: FastifyReply, http: number, message: string) {
  return reply.status(http).send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/** The /v1 routes, called in-process as this user. */
function injectApi(
  app: FastifyInstance,
  devToken: string,
  userId: string,
  playbooks: boolean,
): MatchCutApi {
  const headers = {
    authorization: `Bearer ${devToken}`,
    "x-dev-user-id": userId,
    "x-dev-org-id": MCP_ORG_ID,
  };
  async function call(
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
  ): Promise<ApiResult> {
    const res = await app.inject({ method, url, headers, payload });
    let body: unknown = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = null;
    }
    return { status: res.statusCode, body };
  }
  const id = encodeURIComponent;
  const briefs = {
    create: (body: object) => call("POST", "/v1/briefs", body),
    get: (b: string) => call("GET", `/v1/briefs/${id(b)}`),
    regenerate: (b: string, body: object) => call("POST", `/v1/briefs/${id(b)}/regenerate`, body),
  };
  if (!playbooks) return briefs;
  return {
    ...briefs,
    createPlaybook: (body) => call("POST", "/v1/playbooks", body),
    getPlaybook: (p) => call("GET", `/v1/playbooks/${id(p)}`),
    applyPlaybook: (p, body) => call("POST", `/v1/playbooks/${id(p)}/apply`, body),
    saveSkill: (body) => call("POST", "/v1/skills", body),
    listSkills: () => call("GET", "/v1/skills"),
    applySkill: (s, body) => call("POST", `/v1/skills/${id(s)}/apply`, body),
  };
}

export async function mcpRoutes(app: FastifyInstance, opts: McpRouteOptions) {
  const keys = opts.keys.filter(Boolean);

  app.post("/mcp", async (req, reply) => {
    if (keys.length === 0) {
      return rpcError(reply, 404, "The Match Cut MCP server is not enabled on this deployment.");
    }
    const key = keyFrom(req, keys);
    if (!key) {
      reply.header("www-authenticate", 'Bearer realm="match-cut-mcp"');
      return rpcError(reply, 401, "Missing or invalid Match Cut API key.");
    }
    const api = injectApi(app, opts.devToken, mcpUserId(key), opts.playbooks ?? false);
    const server = buildMcpServer(api, opts);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    // The transport writes the response (JSON or an event stream) straight to the socket.
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless server: no standalone event stream and no sessions to delete.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header("allow", "POST");
    return rpcError(reply, 405, "Method not allowed. Send MCP requests with POST.");
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
