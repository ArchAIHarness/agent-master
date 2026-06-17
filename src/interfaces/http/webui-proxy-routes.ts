import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RuntimeWebUiProxyService } from "../../application/runtime/runtime-webui-proxy-service";
import { requireUserId } from "../../application/runtime/runtime-path-service";
import { mapErrorToStatus } from "./http-errors";

export interface WebUiProxyRoutesDependencies {
  readonly proxyService: RuntimeWebUiProxyService;
  /** Path prefix mounted on the master, e.g. "/webui". Must start with `/`. */
  readonly pathPrefix: string;
}

export async function registerWebUiProxyRoutes(
  app: FastifyInstance,
  dependencies: WebUiProxyRoutesDependencies,
): Promise<void> {
  const prefix = normalizePathPrefix(dependencies.pathPrefix);
  const route = `${prefix}/*`;
  const rootRoute = prefix === "/" ? "/" : prefix;

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      const upstreamPath = stripPrefix(request.url.split("?")[0] ?? "/", prefix);
      const requestPath = upstreamPath === "" ? "/" : upstreamPath;

      const response = await dependencies.proxyService.proxy({
        body: request.body,
        headers: normalizeHeaders(request.headers),
        method: request.method,
        path: requestPath,
        query: normalizeQueryFromUrl(request.url),
        userId,
      });

      if (response.isEventStream && response.stream) {
        // Only SSE responses warrant a periodic lease-renewal timer; non-SSE
        // requests are renewed inline by the service layer on every forward.
        const stopSseLeaseRenewal = dependencies.proxyService.startSseLeaseRenewal({ userId });
        let stopped = false;
        const stop = (): void => {
          if (!stopped) {
            stopped = true;
            stopSseLeaseRenewal();
          }
        };

        reply.raw.writeHead(response.statusCode, response.headers);
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

      for (const [name, value] of Object.entries(response.headers)) {
        reply.header(name, value);
      }
      return reply.code(response.statusCode).send(response.body);
    } catch (error) {
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  };

  app.all(route, handler);
  if (rootRoute !== "/") {
    app.all(rootRoute, handler);
  }
}

function normalizePathPrefix(prefix: string): string {
  if (!prefix) {
    return "/";
  }
  const stripped = prefix.replace(/\/+$/, "");
  if (stripped.length === 0) {
    return "/";
  }
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function stripPrefix(path: string, prefix: string): string {
  if (prefix === "/") {
    return path;
  }
  if (path === prefix) {
    return "/";
  }
  if (path.startsWith(`${prefix}/`)) {
    return path.slice(prefix.length);
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
