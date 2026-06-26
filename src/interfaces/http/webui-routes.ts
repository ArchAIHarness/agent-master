import type { FastifyInstance, FastifyRequest } from "fastify";
import { type RawData, WebSocket as WsWebSocket } from "ws";

import type { RuntimeAgentProxyService } from "../../application/runtime/runtime-agent-proxy-service";
import type { RuntimeAgentWebSocketService } from "../../application/runtime/runtime-agent-websocket-service";
import { RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";

export interface WebUiRoutesDependencies {
  readonly proxyService: RuntimeAgentProxyService;
  readonly websocketService: RuntimeAgentWebSocketService;
}

const WEBUI_PREFIX = "/webui";

const PROXY_REQUEST_BLOCKED_HEADERS = new Set([
  "authorization",
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-user-id",
]);

export async function registerWebUiRoutes(
  app: FastifyInstance,
  dependencies: WebUiRoutesDependencies,
): Promise<void> {
  // WebSocket: /webui/{runtimeId}/ws/*
  app.get(`${WEBUI_PREFIX}/:runtimeId/ws/*`, { websocket: true }, async (socket: WsWebSocket, request: FastifyRequest) => {
    const { runtimeId } = request.params as { runtimeId: string };
    const url = request.url ?? `${WEBUI_PREFIX}/${runtimeId}/ws/`;
    const path = stripWebUiWsPath(url);
    const subprotocols = parseSecWebSocketProtocols(request.headers["sec-websocket-protocol"]);
    const downstream = adaptDownstream(socket);

    try {
      await dependencies.websocketService.bridgeByRuntimeId({
        downstream,
        headers: filterWsUpstreamHeaders(request.headers),
        path,
        query: normalizeWsQueryFromUrl(url),
        subprotocols,
        runtimeId,
      });
    } catch (error) {
      if (error instanceof RuntimeNotFoundError) {
        closeSocket(socket, 1008, "runtime not running");
        return;
      }
      closeSocket(socket, 1011, "websocket bridge failed");
    }
  });

  // HTTP: /webui/{runtimeId}/*
  app.all(`${WEBUI_PREFIX}/:runtimeId/*`, async (request, reply) => {
    const { runtimeId } = request.params as { runtimeId: string };
    const originalPath = request.url.split("?")[0] ?? `${WEBUI_PREFIX}/${runtimeId}/`;
    const path = stripWebUiPath(originalPath);

    try {
      const response = await dependencies.proxyService.proxyByRuntimeId({
        body: request.body,
        headers: filterProxyRequestHeaders(normalizeHeaders(request.headers)),
        method: request.method,
        path,
        query: normalizeQueryFromUrl(request.url),
        runtimeId,
      });

      const responseHeaders = filterProxyResponseHeaders(response.headers);

      // HTML 重写: <base> + src/href
      const contentType = responseHeaders["content-type"] ?? "";
      let body = response.body;
      if (typeof body === "string" && contentType.includes("text/html")) {
        body = rewriteHtmlPaths(body, runtimeId);
      }

      if (responseHeaders["location"]) {
        responseHeaders["location"] = rewriteRedirectLocation(responseHeaders["location"], runtimeId);
      }

      for (const [name, value] of Object.entries(responseHeaders)) {
        reply.header(name, value);
      }

      if (response.isEventStream && response.stream) {
        reply.raw.writeHead(response.statusCode, responseHeaders);
        const reader = response.stream.getReader();
        request.raw.once("close", () => { void reader.cancel(); });
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          reply.raw.write(chunk.value);
        }
        reply.raw.end();
        return reply;
      }

      return reply.code(response.statusCode).send(body instanceof ArrayBuffer ? Buffer.from(body) : body);
    } catch (error) {
      if (error instanceof RuntimeNotFoundError) {
        return reply.code(404).send({ code: "RUNTIME_NOT_FOUND", message: `Agent runtime ${runtimeId} not found or not running.` });
      }
      return reply.code(500).send({ code: "PROXY_ERROR", message: "Failed to proxy webui request" });
    }
  });

  // HTTP 根入口: /webui/{runtimeId}（不带 /* 尾缀，重定向到 /）
  app.all(`${WEBUI_PREFIX}/:runtimeId`, async (request, reply) => {
    const { runtimeId } = request.params as { runtimeId: string };
    return reply.redirect(`${WEBUI_PREFIX}/${runtimeId}/`);
  });

  // WebSocket: /webui/{runtimeId}/ws（不带 /* 尾缀）
  app.get(`${WEBUI_PREFIX}/:runtimeId/ws`, { websocket: true }, async (socket: WsWebSocket, request: FastifyRequest) => {
    const { runtimeId } = request.params as { runtimeId: string };
    const downstream = adaptDownstream(socket);
    try {
      await dependencies.websocketService.bridgeByRuntimeId({
        downstream,
        headers: filterWsUpstreamHeaders(request.headers),
        path: "/",
        query: {},
        subprotocols: parseSecWebSocketProtocols(request.headers["sec-websocket-protocol"]),
        runtimeId,
      });
    } catch (error) {
      if (error instanceof RuntimeNotFoundError) {
        closeSocket(socket, 1008, "runtime not running");
        return;
      }
      closeSocket(socket, 1011, "websocket bridge failed");
    }
  });
}

// ─── HTML 重写 ──────────────────────────────────

function rewriteHtmlPaths(html: string, runtimeId: string): string {
  const prefix = `${WEBUI_PREFIX}/${runtimeId}`;
  let result = html.replace(
    /(src|href)=["']\/(?!webui\/)((?:static|assets|build|js|css|media|fonts)\/[^"']*|[^/"']+\.[a-z]+)["']/gi,
    `$1="${prefix}/$2"`,
  );
  result = result.replace(/(["'])\/ws\//g, `$1${prefix}/ws/`);
  result = result.replace(/<base\s+href=["']\/["']>/gi, `<base href="${prefix}/">`);
  return result;
}

function rewriteRedirectLocation(location: string, runtimeId: string): string {
  if (location.startsWith("/") && !location.startsWith(WEBUI_PREFIX)) {
    return `${WEBUI_PREFIX}/${runtimeId}${location}`;
  }
  return location;
}

// ─── WebSocket 工具 ─────────────────────────────

function parseSecWebSocketProtocols(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const text = Array.isArray(value) ? value.join(",") : value;
  return text.split(",").map((i) => i.trim()).filter((i) => i.length > 0);
}

function normalizeWsQueryFromUrl(url: string): Record<string, string | string[]> {
  const qs = url.indexOf("?");
  if (qs < 0) return {};
  const params = new URLSearchParams(url.slice(qs + 1));
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const vals = params.getAll(key);
    out[key] = vals.length > 1 ? vals : (vals[0] ?? "");
  }
  return out;
}

function filterWsUpstreamHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const nk = key.toLowerCase();
    if (PROXY_REQUEST_BLOCKED_HEADERS.has(nk)) continue;
    out[nk] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

function adaptDownstream(socket: WsWebSocket) {
  return {
    close(code?: number, reason?: string): void { try { socket.close(code, reason); } catch { /* ignore */ } },
    onClose(handler: (code: number, reason: string) => void): void {
      socket.on("close", (code: number, reason: Buffer) => handler(code, reason.toString("utf8")));
    },
    onError(handler: (error: Error) => void): void { socket.on("error", handler); },
    onMessage(handler: (data: string | Buffer) => void): void {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        const buf = toBuffer(data);
        handler(isBinary ? buf : buf.toString("utf8"));
      });
    },
    send(data: string | Buffer): void { socket.send(data as never); },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function closeSocket(socket: WsWebSocket, code: number, reason: string): void {
  try { socket.close(code, reason); } catch { /* ignore */ }
}

// ─── 路径工具 ──────────────────────────────────

function stripWebUiPath(url: string): string {
  const m = url.match(/^\/webui\/[^/]+(\/.*)$/);
  return m?.[1] ?? "/";
}

function stripWebUiWsPath(url: string): string {
  const pathOnly = url.split("?")[0] ?? "";
  const m = pathOnly.match(/^\/webui\/[^/]+\/ws(\/.*)$/);
  return m?.[1] ?? "/";
}

// ─── HTTP 代理工具 ─────────────────────────────

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

const PROXY_RESPONSE_BLOCKED_HEADERS = new Set([
  "connection", "content-encoding", "content-length", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

function filterProxyRequestHeaders(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!PROXY_REQUEST_BLOCKED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function filterProxyResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!PROXY_RESPONSE_BLOCKED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function normalizeQueryFromUrl(url: string): Record<string, string | string[]> {
  const qs = url.indexOf("?");
  if (qs < 0) return {};
  const params = new URLSearchParams(url.slice(qs + 1));
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const vals = params.getAll(key);
    out[key] = vals.length > 1 ? vals : (vals[0] ?? "");
  }
  return out;
}
