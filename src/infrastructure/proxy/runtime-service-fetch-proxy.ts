import type { RuntimeAgentProxyPort, RuntimeProxyRequest, RuntimeProxyResponse } from "../../ports/runtime-agent-proxy-port";

export type RuntimeFetch = (request: Request) => Promise<Response>;

export interface RuntimeServiceFetchProxyOptions {
  readonly namespace: string;
  readonly fetch?: RuntimeFetch;
}

export class RuntimeServiceFetchProxy implements RuntimeAgentProxyPort {
  private readonly fetchImpl: RuntimeFetch;

  constructor(private readonly options: RuntimeServiceFetchProxyOptions) {
    this.fetchImpl = options.fetch ?? ((request) => fetch(request));
  }

  async forward(request: RuntimeProxyRequest): Promise<RuntimeProxyResponse> {
    const url = buildRuntimeServiceUrl({
      namespace: this.options.namespace,
      path: request.path,
      port: request.servicePort,
      query: request.query,
      serviceName: request.serviceName,
    });
    const requestInit: RequestInit = {
      headers: sanitizeHeaders(request.headers),
      method: request.method,
    };
    if (request.body !== undefined && request.method !== "GET") {
      requestInit.body = JSON.stringify(request.body);
    }
    const upstreamRequest = new Request(url, requestInit);
    const response = await this.fetchImpl(upstreamRequest);
    const headers = Object.fromEntries(response.headers.entries());
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      if (!response.body) {
        throw new Error("runtime event stream response has no body");
      }
      return {
        headers,
        isEventStream: true,
        statusCode: response.status,
        stream: response.body,
      };
    }
    return {
      body: await readBody(response),
      headers: stripDecodedBodyHeaders(headers),
      statusCode: response.status,
    };
  }
}

function buildRuntimeServiceUrl(input: {
  readonly namespace: string;
  readonly serviceName: string;
  readonly port: number;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
}): string {
  const url = new URL(`http://${input.serviceName}.${input.namespace}.svc.cluster.local:${input.port}${input.path}`);
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

function sanitizeHeaders(headers: Record<string, string>): Headers {
  const sanitized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      continue;
    }
    sanitized.set(key, value);
  }
  sanitized.set("content-type", "application/json");
  return sanitized;
}

function stripDecodedBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const decodedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      continue;
    }
    decodedHeaders[key] = value;
  }
  return decodedHeaders;
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}
