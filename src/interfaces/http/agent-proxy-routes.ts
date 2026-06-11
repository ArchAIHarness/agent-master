import type { FastifyInstance } from "fastify";

import { isOpenCodeSseProxyPath, type RuntimeAgentProxyService } from "../../application/runtime/runtime-agent-proxy-service";
import { requireUserId } from "../../application/runtime/runtime-path-service";
import { mapErrorToStatus } from "./http-errors";

export interface AgentProxyRoutesDependencies {
  readonly proxyService: RuntimeAgentProxyService;
}

export async function registerAgentProxyRoutes(app: FastifyInstance, dependencies: AgentProxyRoutesDependencies): Promise<void> {
  app.all("/api/v1/runtime/agent/*", async (request, reply) => {
    let stopSseLeaseRenewal: (() => void) | undefined;
    let sseLeaseRenewalAttachedToClose = false;

    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      const path = request.url.split("?")[0]?.replace(/^\/api\/v1\/runtime\/agent/, "") || "/";
      stopSseLeaseRenewal = isOpenCodeSseProxyPath(path)
        ? dependencies.proxyService.startSseLeaseRenewal({ userId })
        : undefined;
      if (stopSseLeaseRenewal) {
        request.raw.once("close", stopSseLeaseRenewal);
        sseLeaseRenewalAttachedToClose = true;
      }
      const response = await dependencies.proxyService.proxy({
        body: request.body,
        headers: normalizeHeaders(request.headers),
        method: request.method,
        path,
        query: normalizeQueryFromUrl(request.url),
        userId,
      });
      for (const [name, value] of Object.entries(response.headers)) {
        reply.header(name, value);
      }
      return reply.code(response.statusCode).send(response.body);
    } catch (error) {
      if (stopSseLeaseRenewal && !sseLeaseRenewalAttachedToClose) {
        stopSseLeaseRenewal();
      }
      if (stopSseLeaseRenewal && sseLeaseRenewalAttachedToClose) {
        stopSseLeaseRenewal();
      }
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return normalized;
}

function normalizeQueryFromUrl(url: string): Record<string, string | string[]> {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) {
    return {};
  }

  const params = new URLSearchParams(url.slice(queryStart + 1));
  const normalized: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    normalized[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  return normalized;
}
