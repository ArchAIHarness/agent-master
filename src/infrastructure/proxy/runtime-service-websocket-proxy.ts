import WebSocket, { type RawData } from "ws";

import type {
  RuntimeAgentWebSocketPort,
  RuntimeWebSocketUpstream,
  RuntimeWebSocketUpstreamRequest,
} from "../../domain/runtime/runtime-agent-websocket-port";

export interface RuntimeServiceWebSocketProxyOptions {
  readonly namespace: string;
  readonly webSocketFactory?: (url: string, subprotocols: readonly string[], headers: Record<string, string>) => WebSocket;
}

export class RuntimeServiceWebSocketProxy implements RuntimeAgentWebSocketPort {
  constructor(private readonly options: RuntimeServiceWebSocketProxyOptions) {}

  connect(request: RuntimeWebSocketUpstreamRequest): RuntimeWebSocketUpstream {
    const url = buildAgentWebSocketUrl({
      namespace: this.options.namespace,
      path: request.path,
      port: request.servicePort,
      query: request.query,
      serviceName: request.serviceName,
    });
    const factory =
      this.options.webSocketFactory ??
      ((target, subprotocols, headers) =>
        new WebSocket(target, subprotocols.length > 0 ? [...subprotocols] : undefined, { headers }));
    const socket = factory(url, request.subprotocols, sanitizeWebSocketHeaders(request.headers));

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
          if (isBinary) {
            handler(toBuffer(data));
            return;
          }
          handler(toBuffer(data).toString("utf8"));
        });
      },
      onOpen(handler) {
        socket.on("open", () => {
          handler();
        });
      },
      send(data) {
        socket.send(data as never);
      },
    };
  }
}

function buildAgentWebSocketUrl(input: {
  readonly namespace: string;
  readonly serviceName: string;
  readonly port: number;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
}): string {
  const url = new URL(`ws://${input.serviceName}.${input.namespace}.svc.cluster.local:${input.port}${input.path}`);
  for (const [key, value] of Object.entries(input.query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function sanitizeWebSocketHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === "authorization" || normalized === "proxy-authorization") {
      continue;
    }
    sanitized[normalized] = value;
  }
  return sanitized;
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
