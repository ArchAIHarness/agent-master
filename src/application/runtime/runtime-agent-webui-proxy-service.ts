import { RuntimeAggregate } from "../../domain/runtime/runtime";
import { RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";
import type { RuntimeClock } from "../../ports/runtime-clock";
import type { RuntimeAgentProxyPort, RuntimeProxyHeaders, RuntimeProxyQuery, RuntimeProxyResponse } from "../../ports/runtime-agent-proxy-port";
import type { RuntimeEventBus } from "../../ports/runtime-event-bus";
import type { RuntimeStore } from "../../ports/runtime-store";

export interface RuntimeAgentWebuiProxyServiceDependencies {
  readonly clock: RuntimeClock;
  readonly eventBus: RuntimeEventBus;
  readonly proxy: RuntimeAgentProxyPort;
  readonly store: RuntimeStore;
  readonly ttlSeconds: number;
  readonly agentWebuiPort: number;
}

export interface RuntimeAgentWebuiProxyInput {
  readonly userId: string;
  readonly method: string;
  readonly path: string;
  readonly query: RuntimeProxyQuery;
  readonly headers: Record<string, string | undefined>;
  readonly body?: unknown;
}

export class RuntimeAgentWebuiProxyService {
  constructor(private readonly dependencies: RuntimeAgentWebuiProxyServiceDependencies) {}

  startSseLeaseRenewal(input: { userId: string; intervalMs?: number }): () => void {
    const interval = setInterval(() => {
      void this.renewLease(input.userId);
    }, input.intervalMs ?? 300_000);
    return () => clearInterval(interval);
  }

  async proxy(input: RuntimeAgentWebuiProxyInput): Promise<RuntimeProxyResponse> {
    const runtime = await this.dependencies.store.getByUserId(input.userId);
    if (!runtime || runtime.status !== "running") {
      throw new RuntimeNotFoundError(input.userId);
    }

    const response = await this.dependencies.proxy.forward({
      body: input.body,
      headers: stripAgentWebuiUpstreamHeaders(input.headers),
      method: input.method,
      path: input.path,
      query: input.query,
      serviceName: runtime.serviceName,
      servicePort: this.dependencies.agentWebuiPort,
    });

    await this.renewLease(input.userId);
    return response;
  }

  private async renewLease(userId: string): Promise<void> {
    const snapshot = await this.dependencies.store.getByUserId(userId);
    if (!snapshot) {
      return;
    }
    const runtime = RuntimeAggregate.rehydrate(snapshot);
    runtime.extendLease(this.dependencies.clock.plusSeconds(this.dependencies.ttlSeconds));
    for (const event of runtime.pullEvents()) {
      await this.dependencies.eventBus.publish(event);
    }
    await this.dependencies.store.save(runtime.snapshot());
  }
}

const AGENT_WEBUI_REQUEST_BLOCKED_HEADERS = new Set([
  "authorization",
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-user-id",
]);

function stripAgentWebuiUpstreamHeaders(headers: Record<string, string | undefined>): RuntimeProxyHeaders {
  const filtered: RuntimeProxyHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (AGENT_WEBUI_REQUEST_BLOCKED_HEADERS.has(normalized)) {
      continue;
    }
    filtered[normalized] = value;
  }
  return filtered;
}
