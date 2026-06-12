import type { KubernetesHttpClient } from "./kubernetes-rest-workload-adapter";

export interface KubernetesFetchHttpClientOptions {
  readonly apiServer: string;
  readonly token?: string;
  readonly caCert?: string;
  readonly fetch?: typeof fetch;
}

export class KubernetesFetchHttpClient implements KubernetesHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KubernetesFetchHttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request(input: { method: string; path: string; body?: unknown; contentType?: string }): Promise<unknown> {
    const requestInit: RequestInit & { tls?: { ca?: string } } = {
      headers: {
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        "content-type": input.contentType ?? "application/json",
      },
      method: input.method,
    };
    if (input.body !== undefined) {
      requestInit.body = JSON.stringify(input.body);
    }
    if (this.options.caCert) {
      requestInit.tls = { ca: this.options.caCert };
    }
    const response = await this.fetchImpl(`${this.options.apiServer}${input.path}`, requestInit);
    if (!response.ok) {
      throw new Error(`kubernetes request failed: ${response.status}`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }
}
