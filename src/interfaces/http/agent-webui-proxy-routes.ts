import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RuntimeAgentWebuiProxyService } from "../../application/runtime/runtime-agent-webui-proxy-service";
import { requireUserId } from "../../application/runtime/runtime-path-service";
import { mapErrorToStatus } from "./http-errors";

export interface AgentWebuiProxyRoutesDependencies {
  readonly proxyService: RuntimeAgentWebuiProxyService;
  readonly pathPrefix: string;
}

export async function registerAgentWebuiProxyRoutes(
  app: FastifyInstance,
  dependencies: AgentWebuiProxyRoutesDependencies,
): Promise<void> {
  const prefix = normalizePathPrefix(dependencies.pathPrefix);
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      const requestPath = normalizeAgentWebuiUpstreamPath(request.url.split("?")[0] ?? "/", prefix);
      const response = await dependencies.proxyService.proxy({
        body: request.body,
        headers: normalizeHeaders(request.headers),
        method: request.method,
        path: requestPath,
        query: normalizeQueryFromUrl(request.url),
        userId,
      });

      const headers = filterResponseHeaders(response.headers);
      if (response.isEventStream && response.stream) {
        const stopSseLeaseRenewal = dependencies.proxyService.startSseLeaseRenewal({ userId });
        let stopped = false;
        const stop = (): void => {
          if (!stopped) {
            stopped = true;
            stopSseLeaseRenewal();
          }
        };

        reply.raw.writeHead(response.statusCode, headers);
        const reader = response.stream.getReader();
        request.raw.once("close", () => {
          stop();
          void reader.cancel();
        });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            reply.raw.write(chunk.value);
          }
          reply.raw.end();
        } finally {
          stop();
        }
        return reply;
      }

      for (const [name, value] of Object.entries(headers)) {
        reply.header(name, value);
      }
      return reply.code(response.statusCode).send(response.body);
    } catch (error) {
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  };

  app.all(`${prefix}/*`, handler);
  if (prefix !== "/") {
    app.all(prefix, handler);
  }
}

function normalizePathPrefix(prefix: string): string {
  if (!prefix) {
    return "/webui";
  }
  const stripped = prefix.replace(/\/+$/, "");
  if (stripped.length === 0) {
    return "/";
  }
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function normalizeAgentWebuiUpstreamPath(path: string, prefix: string): string {
  if (prefix === "/") {
    return path;
  }
  if (path === prefix) {
    return `${prefix}/`;
  }
  if (path.startsWith(`${prefix}/`)) {
    return path;
  }
  return path;
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

const RESPONSE_BLOCKED_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filterResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!RESPONSE_BLOCKED_HEADERS.has(name.toLowerCase())) {
      filtered[name] = value;
    }
  }
  return filtered;
}
