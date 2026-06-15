import type { AgentAppAdapterConstructor } from "./agent-app-port";
import { AgentAppRegistry } from "./agent-app-registry";

export function agentApp(name: string): ClassDecorator {
  return (target) => {
    AgentAppRegistry.register(name, target as unknown as AgentAppAdapterConstructor);
  };
}
