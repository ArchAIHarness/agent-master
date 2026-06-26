export type RuntimeProxyHeaders = Record<string, string>;
export type RuntimeProxyQueryValue = string | string[];
export type RuntimeProxyQuery = Record<string, RuntimeProxyQueryValue>;

export interface RuntimeProxyRequest {
  readonly method: string;
  readonly path: string;
  readonly query: RuntimeProxyQuery;
  readonly headers: RuntimeProxyHeaders;
  readonly body?: unknown;
  readonly serviceName: string;
  readonly servicePort: number;
}

export interface RuntimeProxyResponse {
  readonly statusCode: number;
  readonly headers: RuntimeProxyHeaders;
  readonly body?: unknown;
  readonly stream?: ReadableStream<Uint8Array>;
  readonly isEventStream?: boolean;
}

export interface RuntimeAgentProxyPort {
  forward(request: RuntimeProxyRequest): Promise<RuntimeProxyResponse>;
}
