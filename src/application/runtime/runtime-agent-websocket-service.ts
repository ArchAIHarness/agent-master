import { RuntimeAggregate, type RuntimeSnapshot } from "../../domain/runtime/runtime";
import { RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";
import type { RuntimeClock } from "../../domain/runtime/runtime-clock";
import type {
  RuntimeAgentWebSocketPort,
  RuntimeWebSocketDownstream,
  RuntimeWebSocketHeaders,
  RuntimeWebSocketQuery,
} from "../../domain/runtime/runtime-agent-websocket-port";
import type { RuntimeEventBus } from "../../domain/runtime/runtime-event-bus";
import type { RuntimeStore } from "../../domain/runtime/runtime-store";

export interface RuntimeAgentWebSocketServiceDependencies {
  readonly clock: RuntimeClock;
  readonly eventBus: RuntimeEventBus;
  readonly store: RuntimeStore;
  readonly websocket: RuntimeAgentWebSocketPort;
  readonly ttlSeconds: number;
  readonly leaseRenewalIntervalMs?: number;
}

export interface RuntimeAgentWebSocketBridgeInput {
  readonly userId: string;
  readonly path: string;
  readonly query: RuntimeWebSocketQuery;
  readonly headers: RuntimeWebSocketHeaders;
  readonly subprotocols: readonly string[];
  readonly downstream: RuntimeWebSocketDownstream;
}

export interface RuntimeWebSocketBridgeByRuntimeIdInput {
  readonly runtimeId: string;
  readonly path: string;
  readonly query: RuntimeWebSocketQuery;
  readonly headers: RuntimeWebSocketHeaders;
  readonly subprotocols: readonly string[];
  readonly downstream: RuntimeWebSocketDownstream;
}

const DEFAULT_LEASE_RENEWAL_MS = 300_000;

export class RuntimeAgentWebSocketService {
  constructor(private readonly dependencies: RuntimeAgentWebSocketServiceDependencies) {}

  async bridge(input: RuntimeAgentWebSocketBridgeInput): Promise<void> {
    const runtime = await this.dependencies.store.getByUserId(input.userId);
    if (!runtime || runtime.status !== "running") {
      throw new RuntimeNotFoundError(input.userId);
    }
    // /agent/ws/* → opencode API port
    await this.bridgeToRuntime(runtime, input.userId, input, runtime.opencodePort);
  }

  async bridgeByRuntimeId(input: RuntimeWebSocketBridgeByRuntimeIdInput): Promise<void> {
    const runtime = await this.dependencies.store.getByRuntimeId(input.runtimeId);
    if (!runtime || runtime.status !== "running") {
      throw new RuntimeNotFoundError(input.runtimeId);
    }
    // 子域名 WebSocket → code-server port (servicePort)
    await this.bridgeToRuntime(runtime, runtime.userId, input);
  }

  private async bridgeToRuntime(
    runtime: RuntimeSnapshot,
    userId: string,
    input: { path: string; query: RuntimeWebSocketQuery; headers: RuntimeWebSocketHeaders; subprotocols: readonly string[]; downstream: RuntimeWebSocketDownstream },
    port?: number,
  ): Promise<void> {

    const upstream = this.dependencies.websocket.connect({
      headers: input.headers,
      path: input.path,
      query: input.query,
      serviceName: runtime.serviceName,
      servicePort: port ?? runtime.servicePort,
      subprotocols: input.subprotocols,
    });

    let closed = false;
    let renewalTimer: ReturnType<typeof setInterval> | undefined;

    const stopLeaseRenewal = (): void => {
      if (renewalTimer !== undefined) {
        clearInterval(renewalTimer);
        renewalTimer = undefined;
      }
    };

    const closeBoth = (code?: number, reason?: string): void => {
      if (closed) {
        return;
      }
      closed = true;
      stopLeaseRenewal();
      try {
        upstream.close(code, reason);
      } catch {
        // ignore
      }
      try {
        input.downstream.close(code, reason);
      } catch {
        // ignore
      }
    };

    upstream.onOpen(() => {
      void this.renewLease(userId);
      const intervalMs = this.dependencies.leaseRenewalIntervalMs ?? DEFAULT_LEASE_RENEWAL_MS;
      renewalTimer = setInterval(() => {
        void this.renewLease(userId);
      }, intervalMs);
    });

    upstream.onMessage((data) => {
      try {
        input.downstream.send(data);
      } catch {
        closeBoth(1011, "downstream send failed");
      }
    });

    upstream.onClose((code, reason) => {
      closeBoth(code, reason);
    });

    upstream.onError(() => {
      closeBoth(1011, "upstream error");
    });

    input.downstream.onMessage((data) => {
      try {
        upstream.send(data);
      } catch {
        closeBoth(1011, "upstream send failed");
      }
    });

    input.downstream.onClose((code, reason) => {
      closeBoth(code, reason);
    });

    input.downstream.onError(() => {
      closeBoth(1011, "downstream error");
    });
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

export function isOpenCodeWebSocketProxyPath(path: string): boolean {
  return /^\/pty\/[^/]+\/connect$/.test(path);
}
