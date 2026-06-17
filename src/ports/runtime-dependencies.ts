import type { RuntimeClock } from "./runtime-clock";
import type { RuntimeEventBus } from "./runtime-event-bus";
import type { RuntimeAgentProxyPort } from "./runtime-agent-proxy-port";
import type { UserWorkspaceInitializer } from "./user-workspace-initializer";
import type { RuntimeStore } from "./runtime-store";
import type { RuntimeWorkloadPort } from "./runtime-workload-port";

export interface RuntimeDependenciesOptions {
  readonly clock: RuntimeClock;
  readonly cluster: string;
  readonly eventBus: RuntimeEventBus;
  readonly namespace: string;
  readonly proxy: RuntimeAgentProxyPort;
  readonly runtimeImage: string;
  readonly runtimePort: number;
  readonly store: RuntimeStore;
  readonly templatesRoot: string;
  readonly ttlSeconds: number;
  readonly userWorkspaceInitializer: UserWorkspaceInitializer;
  readonly workload: RuntimeWorkloadPort;
  readonly workdirRoot: string;
}
