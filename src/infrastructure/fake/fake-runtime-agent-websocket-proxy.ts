import type {
  RuntimeAgentWebSocketPort,
  RuntimeWebSocketUpstream,
  RuntimeWebSocketUpstreamRequest,
} from "../../ports/runtime-agent-websocket-port";

export interface FakeRuntimeAgentWebSocket extends RuntimeWebSocketUpstream {
  readonly request: RuntimeWebSocketUpstreamRequest;
  readonly sent: Array<string | Buffer>;
  closed: boolean;
  closedCode?: number;
  closedReason?: string;
  triggerOpen(): void;
  triggerMessage(data: string | Buffer): void;
  triggerClose(code: number, reason: string): void;
  triggerError(error: Error): void;
}

export class FakeRuntimeAgentWebSocketProxy implements RuntimeAgentWebSocketPort {
  readonly connections: FakeRuntimeAgentWebSocket[] = [];

  connect(request: RuntimeWebSocketUpstreamRequest): RuntimeWebSocketUpstream {
    const handlers: {
      open?: () => void;
      message?: (data: string | Buffer) => void;
      close?: (code: number, reason: string) => void;
      error?: (error: Error) => void;
    } = {};
    const sent: Array<string | Buffer> = [];

    const fake: FakeRuntimeAgentWebSocket = {
      closed: false,
      onClose(handler) {
        handlers.close = handler;
      },
      onError(handler) {
        handlers.error = handler;
      },
      onMessage(handler) {
        handlers.message = handler;
      },
      onOpen(handler) {
        handlers.open = handler;
      },
      close(code, reason) {
        if (fake.closed) {
          return;
        }
        fake.closed = true;
        if (code !== undefined) {
          fake.closedCode = code;
        }
        if (reason !== undefined) {
          fake.closedReason = reason;
        }
      },
      send(data) {
        if (typeof data === "string") {
          sent.push(data);
        } else if (Buffer.isBuffer(data)) {
          sent.push(data);
        } else if (data instanceof Uint8Array) {
          sent.push(Buffer.from(data));
        } else {
          sent.push(Buffer.from(data as ArrayBuffer));
        }
      },
      sent,
      request,
      triggerClose(code, reason) {
        handlers.close?.(code, reason);
      },
      triggerError(error) {
        handlers.error?.(error);
      },
      triggerMessage(data) {
        handlers.message?.(data);
      },
      triggerOpen() {
        handlers.open?.();
      },
    };
    this.connections.push(fake);
    return fake;
  }
}
