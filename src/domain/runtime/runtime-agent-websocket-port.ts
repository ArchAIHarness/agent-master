export type RuntimeWebSocketHeaders = Record<string, string>;
export type RuntimeWebSocketQueryValue = string | string[];
export type RuntimeWebSocketQuery = Record<string, RuntimeWebSocketQueryValue>;

export interface RuntimeWebSocketDownstream {
  send(data: string | ArrayBufferLike | Buffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | Buffer) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface RuntimeWebSocketUpstreamRequest {
  readonly serviceName: string;
  readonly servicePort: number;
  readonly path: string;
  readonly query: RuntimeWebSocketQuery;
  readonly headers: RuntimeWebSocketHeaders;
  readonly subprotocols: readonly string[];
}

export interface RuntimeWebSocketUpstream {
  send(data: string | ArrayBufferLike | Buffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string | Buffer) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface RuntimeAgentWebSocketPort {
  connect(request: RuntimeWebSocketUpstreamRequest): RuntimeWebSocketUpstream;
}
