import type { RawData, WebSocket as WsWebSocket } from "ws";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  isOpenCodeWebSocketProxyPath,
  type RuntimeAgentWebSocketService,
} from "../../application/runtime/runtime-agent-websocket-service";
import { requireUserId } from "../../application/runtime/runtime-path-service";
import {
  InvalidUserIdError,
  MissingUserIdError,
  RuntimeNotFoundError,
} from "../../domain/runtime/runtime-errors";
import type {
  RuntimeWebSocketDownstream,
  RuntimeWebSocketHeaders,
  RuntimeWebSocketQuery,
} from "../../ports/runtime-agent-websocket-port";

export interface AgentWebSocketRoutesDependencies {
  readonly websocketService: RuntimeAgentWebSocketService;
}

const X_USER_ID_QUERY = "x-user-id";
const X_USER_ID_PROTOCOL_PREFIX = "x-user-id.";
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

export async function registerAgentWebSocketRoutes(
  app: FastifyInstance,
  dependencies: AgentWebSocketRoutesDependencies,
): Promise<void> {
  app.get("/agent/ws/*", { websocket: true }, async (socket: WsWebSocket, request: FastifyRequest) => {
    const url = request.url ?? "/agent/ws/";
    const path = stripWebSocketPrefix(url);
    if (!isOpenCodeWebSocketProxyPath(path)) {
      closeSocket(socket, 1008, "websocket proxy path not allowed");
      return;
    }

    const subprotocols = parseSecWebSocketProtocols(request.headers["sec-websocket-protocol"]);
    let userId: string;
    try {
      userId = resolveUserId(url, subprotocols);
    } catch (error) {
      const reason =
        error instanceof MissingUserIdError
          ? "missing x-user-id"
          : error instanceof InvalidUserIdError
            ? "invalid x-user-id"
            : "invalid request";
      closeSocket(socket, 1008, reason);
      return;
    }

    const downstream = adaptDownstream(socket);
    try {
      await dependencies.websocketService.bridge({
        downstream,
        headers: filterUpstreamHeaders(request.headers),
        path,
        query: stripUserIdQuery(normalizeQueryFromUrl(url)),
        subprotocols: filterUpstreamSubprotocols(subprotocols),
        userId,
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

function stripWebSocketPrefix(url: string): string {
  const path = url.split("?")[0] ?? "/agent/ws";
  const stripped = path.replace(/^\/agent\/ws/, "");
  return stripped.length === 0 ? "/" : stripped;
}

function parseSecWebSocketProtocols(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  const text = Array.isArray(value) ? value.join(",") : value;
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveUserId(url: string, subprotocols: readonly string[]): string {
  const queryValue = readQueryParam(url, X_USER_ID_QUERY);
  if (queryValue !== undefined) {
    return requireUserId(queryValue);
  }
  for (const protocol of subprotocols) {
    if (protocol.startsWith(X_USER_ID_PROTOCOL_PREFIX)) {
      return requireUserId(protocol.slice(X_USER_ID_PROTOCOL_PREFIX.length));
    }
  }
  return requireUserId(undefined);
}

function readQueryParam(url: string, name: string): string | undefined {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) {
    return undefined;
  }
  const params = new URLSearchParams(url.slice(queryStart + 1));
  const raw = params.get(name);
  return raw ?? undefined;
}

function normalizeQueryFromUrl(url: string): RuntimeWebSocketQuery {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) {
    return {};
  }
  const params = new URLSearchParams(url.slice(queryStart + 1));
  const normalized: RuntimeWebSocketQuery = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    normalized[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  return normalized;
}

function stripUserIdQuery(query: RuntimeWebSocketQuery): RuntimeWebSocketQuery {
  const result: RuntimeWebSocketQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (key.toLowerCase() === X_USER_ID_QUERY) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function filterUpstreamHeaders(
  headers: Record<string, string | string[] | undefined>,
): RuntimeWebSocketHeaders {
  const filtered: RuntimeWebSocketHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (PROXY_REQUEST_BLOCKED_HEADERS.has(normalized)) {
      continue;
    }
    filtered[normalized] = Array.isArray(value) ? value.join(",") : value;
  }
  return filtered;
}

function filterUpstreamSubprotocols(subprotocols: readonly string[]): string[] {
  return subprotocols.filter((item) => !item.startsWith(X_USER_ID_PROTOCOL_PREFIX));
}

function adaptDownstream(socket: WsWebSocket): RuntimeWebSocketDownstream {
  return {
    close(code, reason) {
      try {
        socket.close(code, reason);
      } catch {
        // ignore
      }
    },
    onClose(handler) {
      socket.on("close", (code: number, reason: Buffer) => {
        handler(code, reason.toString("utf8"));
      });
    },
    onError(handler) {
      socket.on("error", (error: Error) => {
        handler(error);
      });
    },
    onMessage(handler) {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        const buffer = toBuffer(data);
        if (isBinary) {
          handler(buffer);
          return;
        }
        handler(buffer.toString("utf8"));
      });
    },
    send(data) {
      socket.send(data as never);
    },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data as ArrayBuffer);
}

function closeSocket(socket: WsWebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // ignore
  }
}
