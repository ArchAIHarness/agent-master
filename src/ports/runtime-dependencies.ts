import type { RuntimeAgentPresetRegistry } from "../domain/runtime/runtime-policy";
import type { RuntimeClock } from "./runtime-clock";
import type { RuntimeEventBus } from "./runtime-event-bus";
import type { RuntimeAgentProxyPort } from "./runtime-agent-proxy-port";
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
  readonly agentPresets: RuntimeAgentPresetRegistry;
  readonly store: RuntimeStore;
  readonly ttlSeconds: number;
  readonly workload: RuntimeWorkloadPort;
  readonly workdirRoot: string;
}
