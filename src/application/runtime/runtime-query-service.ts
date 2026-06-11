import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeStore } from "../../ports/runtime-store";

export interface RuntimeQueryServiceDependencies {
  readonly store: RuntimeStore;
}

export class RuntimeQueryService {
  constructor(private readonly dependencies: RuntimeQueryServiceDependencies) {}

  async getRuntime(input: { userId: string }): Promise<RuntimeSnapshot | null> {
    return this.dependencies.store.getByUserId(input.userId);
  }
}
