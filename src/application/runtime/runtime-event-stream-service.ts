import { RuntimeAggregate } from "../../domain/runtime/runtime";
import { createRuntimeEvent, type RuntimeEvent } from "../../domain/runtime/runtime-events";
import type { RuntimeClock } from "../../ports/runtime-clock";
import type { RuntimeEventBus, RuntimeEventListener } from "../../ports/runtime-event-bus";
import type { RuntimeStore } from "../../ports/runtime-store";

export interface RuntimeEventStreamServiceDependencies {
  readonly clock: RuntimeClock;
  readonly eventBus: RuntimeEventBus;
  readonly store: RuntimeStore;
  readonly ttlSeconds: number;
}

export class RuntimeEventStreamService {
  constructor(private readonly dependencies: RuntimeEventStreamServiceDependencies) {}

  subscribe(input: { userId: string; listener: RuntimeEventListener }): () => void {
    return this.dependencies.eventBus.subscribe(input.userId, input.listener);
  }

  async heartbeat(input: { userId: string }): Promise<RuntimeEvent> {
    const runtime = await this.dependencies.store.getByUserId(input.userId);
    return createRuntimeEvent("runtime.heartbeat", {
      ...(runtime ? { runtimeId: runtime.runtimeId, status: runtime.status } : {}),
      time: this.dependencies.clock.now().toISOString(),
      userId: input.userId,
    });
  }

  async renewLease(input: { userId: string }): Promise<void> {
    const runtime = await this.dependencies.store.getByUserId(input.userId);
    if (!runtime) {
      return;
    }
    const aggregate = RuntimeAggregate.rehydrate(runtime);
    aggregate.extendLease(this.dependencies.clock.plusSeconds(this.dependencies.ttlSeconds));
    for (const event of aggregate.pullEvents()) {
      await this.dependencies.eventBus.publish(event);
    }
    await this.dependencies.store.save(aggregate.snapshot());
  }
}
