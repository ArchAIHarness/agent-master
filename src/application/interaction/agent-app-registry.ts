import type { AgentAppAdapter, AgentAppAdapterConstructor, AgentAppContext } from "./agent-app-port";

export class UnknownAgentAppError extends Error {
  constructor(readonly appName: string) {
    super(`Unknown AgentApp: ${appName}`);
    this.name = "UnknownAgentAppError";
  }
}

export class AgentAppRegistry {
  private static readonly constructors = new Map<string, AgentAppAdapterConstructor>();

  static register(name: string, constructor: AgentAppAdapterConstructor): void {
    this.constructors.set(name, constructor);
  }

  static getConstructor(name: string): AgentAppAdapterConstructor {
    const constructor = this.constructors.get(name);
    if (!constructor) {
      throw new UnknownAgentAppError(name);
    }
    return constructor;
  }

  static getKnownNames(): string[] {
    return Array.from(this.constructors.keys());
  }

  static assemble(context: AgentAppContext): Map<string, AgentAppAdapter> {
    const instances = new Map<string, AgentAppAdapter>();
    for (const name of this.getKnownNames()) {
      const Constructor = this.getConstructor(name);
      instances.set(name, new Constructor(context));
    }
    return instances;
  }
}
