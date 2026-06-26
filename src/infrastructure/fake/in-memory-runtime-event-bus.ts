import type { RuntimeEvent } from "../../domain/runtime/runtime-events";
import type { RuntimeEventBus, RuntimeEventListener } from "../../domain/runtime/runtime-event-bus";

export class InMemoryRuntimeEventBus implements RuntimeEventBus {
  readonly published: RuntimeEvent[] = [];
  private readonly listeners = new Map<string, Set<RuntimeEventListener>>();

  async publish(event: RuntimeEvent): Promise<void> {
    this.published.push(event);
    const listeners = this.listeners.get(event.payload.userId) ?? new Set<RuntimeEventListener>();
    for (const listener of listeners) {
      await listener(event);
    }
  }

  subscribe(userId: string, listener: RuntimeEventListener): () => void {
    const listeners = this.listeners.get(userId) ?? new Set<RuntimeEventListener>();
    listeners.add(listener);
    this.listeners.set(userId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(userId);
      }
    };
  }

  clear(): void {
    this.published.length = 0;
  }
}
