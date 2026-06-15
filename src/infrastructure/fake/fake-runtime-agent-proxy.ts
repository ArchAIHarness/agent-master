import type { RuntimeAgentProxyPort, RuntimeProxyRequest, RuntimeProxyResponse } from "../../ports/runtime-agent-proxy-port";

export class FakeRuntimeAgentProxy implements RuntimeAgentProxyPort {
  readonly requests: RuntimeProxyRequest[] = [];
  readonly responses: RuntimeProxyResponse[] = [];
  response?: RuntimeProxyResponse;

  enqueueResponse(response: RuntimeProxyResponse): void {
    this.responses.push(response);
  }

  async forward(request: RuntimeProxyRequest): Promise<RuntimeProxyResponse> {
    this.requests.push(request);
    return this.responses.shift() ?? this.response ?? {
      body: {
        proxied: true,
        path: request.path,
        query: request.query,
      },
      headers: {
        "content-type": "application/json",
      },
      statusCode: 200,
    };
  }
}
