import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeStore } from "../../domain/runtime/runtime-store";

export class InMemoryRuntimeStore implements RuntimeStore {
  private readonly runtimes = new Map<string, RuntimeSnapshot>();

  async getByUserId(userId: string): Promise<RuntimeSnapshot | null> {
    const snapshot = this.runtimes.get(userId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  async getByRuntimeId(runtimeId: string): Promise<RuntimeSnapshot | null> {
    for (const snapshot of this.runtimes.values()) {
      if (snapshot.runtimeId === runtimeId) {
        return cloneSnapshot(snapshot);
      }
    }
    return null;
  }

  async tryCreateForUser(snapshot: RuntimeSnapshot, _ttlSeconds: number): Promise<boolean> {
    if (this.runtimes.has(snapshot.userId)) {
      return false;
    }
    this.runtimes.set(snapshot.userId, cloneSnapshot(snapshot));
    return true;
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
