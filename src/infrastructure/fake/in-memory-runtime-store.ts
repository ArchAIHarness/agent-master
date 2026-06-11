import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeStore } from "../../ports/runtime-store";

export class InMemoryRuntimeStore implements RuntimeStore {
  private readonly runtimes = new Map<string, RuntimeSnapshot>();

  async getByUserId(userId: string): Promise<RuntimeSnapshot | null> {
    const snapshot = this.runtimes.get(userId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  async save(snapshot: RuntimeSnapshot): Promise<void> {
    this.runtimes.set(snapshot.userId, cloneSnapshot(snapshot));
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.runtimes.delete(userId);
  }
}

function cloneSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    ...snapshot,
    podSelector: { ...snapshot.podSelector },
  };
}
