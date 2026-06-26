import type { RuntimeClock } from "../../domain/runtime/runtime-clock";
import type { RuntimeEventBus } from "../../domain/runtime/runtime-event-bus";
import type { RuntimeAgentProxyPort } from "../../domain/runtime/runtime-agent-proxy-port";
import type { RuntimeAgentWebSocketPort } from "../../domain/runtime/runtime-agent-websocket-port";
import type { RuntimeStore } from "../../domain/runtime/runtime-store";
import type { RuntimeWorkloadPort } from "../../domain/runtime/runtime-workload-port";
import type { UserWorkspaceInitializer } from "../../domain/runtime/user-workspace-initializer";
import type { RuntimeCommandService } from "./runtime-command-service";

export interface RuntimeDependenciesOptions {
  readonly clock: RuntimeClock;
  readonly cluster: string;
  readonly eventBus: RuntimeEventBus;
  readonly namespace: string;
  readonly proxy: RuntimeAgentProxyPort;
  readonly runtimeImage: string;
  readonly runtimePort: number;
  readonly opencodePort: number;
  readonly store: RuntimeStore;
  readonly templatesRoot: string;
  readonly ttlSeconds: number;
  readonly websocket?: RuntimeAgentWebSocketPort;
  readonly workload: RuntimeWorkloadPort;
  readonly workdirRoot: string;
  readonly webuiDomainTemplate: string;
  readonly commandService: RuntimeCommandService;
}
