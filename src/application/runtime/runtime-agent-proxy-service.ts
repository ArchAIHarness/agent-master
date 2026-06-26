import { RuntimeAggregate, type RuntimeSnapshot } from "../../domain/runtime/runtime";
import { RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";
import type { RuntimeClock } from "../../domain/runtime/runtime-clock";
import type { RuntimeAgentProxyPort, RuntimeProxyQuery, RuntimeProxyResponse } from "../../domain/runtime/runtime-agent-proxy-port";
import type { RuntimeEventBus } from "../../domain/runtime/runtime-event-bus";
import type { RuntimeStore } from "../../domain/runtime/runtime-store";
import { stripAuthorizationHeader } from "./runtime-path-service";

export interface RuntimeAgentProxyServiceDependencies {
  readonly clock: RuntimeClock;
  readonly eventBus: RuntimeEventBus;
  readonly proxy: RuntimeAgentProxyPort;
  readonly store: RuntimeStore;
  readonly ttlSeconds: number;
}

export interface RuntimeAgentProxyInput {
  readonly userId: string;
  readonly method: string;
  readonly path: string;
  readonly query: RuntimeProxyQuery;
  readonly headers: Record<string, string | undefined>;
  readonly body?: unknown;
}

export interface RuntimeAgentProxyByRuntimeIdInput {
  readonly runtimeId: string;
  readonly method: string;
  readonly path: string;
  readonly query: RuntimeProxyQuery;
  readonly headers: Record<string, string | undefined>;
  readonly body?: unknown;
}

export class RuntimeAgentProxyService {
  constructor(private readonly dependencies: RuntimeAgentProxyServiceDependencies) {}

  startSseLeaseRenewal(input: { userId: string; intervalMs?: number }): () => void {
    const interval = setInterval(() => {
      void this.renewLease(input.userId);
    }, input.intervalMs ?? 300_000);
    return () => clearInterval(interval);
  }

  async renewLease(userId: string): Promise<void> {
    const runtime = await this.dependencies.store.getByUserId(userId);
    await this.extendLease(runtime);
  }

  async proxy(input: RuntimeAgentProxyInput): Promise<RuntimeProxyResponse> {
    const runtime = await this.dependencies.store.getByUserId(input.userId);
    if (!runtime || runtime.status !== "running") {
      throw new RuntimeNotFoundError(input.userId);
    }
    // /agent/* → opencode API port
    return this.forwardToRuntime(runtime, input, runtime.opencodePort);
  }

  async proxyByRuntimeId(input: RuntimeAgentProxyByRuntimeIdInput): Promise<RuntimeProxyResponse> {
    const runtime = await this.dependencies.store.getByRuntimeId(input.runtimeId);
    if (!runtime || runtime.status !== "running") {
      throw new RuntimeNotFoundError(input.runtimeId);
    }
    // 子域名/webui → code-server port (servicePort)
    return this.forwardToRuntime(runtime, input);
  }

  private async forwardToRuntime(
    runtime: RuntimeSnapshot,
    input: { body?: unknown; method: string; path: string; query: RuntimeProxyQuery; headers: Record<string, string | undefined> },
    port?: number,
  ): Promise<RuntimeProxyResponse> {
    const response = await this.dependencies.proxy.forward({
      body: input.body,
      headers: stripAuthorizationHeader(input.headers),
      method: input.method,
      path: input.path,
      query: input.query,
      serviceName: runtime.serviceName,
      servicePort: port ?? runtime.servicePort,
    });

    await this.extendLease(runtime);
    return response;
  }

  private async extendLease(snapshot: Awaited<ReturnType<RuntimeStore["getByUserId"]>>): Promise<void> {
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

export function isOpenCodeSseProxyPath(path: string): boolean {
  return path === "/event" || path === "/global/event";
}
