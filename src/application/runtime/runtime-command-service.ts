import { RuntimeAggregate, type RuntimeSnapshot } from "../../domain/runtime/runtime";
import { RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";
import { buildRuntimeWorkspaceRoot } from "../../domain/runtime/runtime-policy";
import type { RuntimeClock } from "../../ports/runtime-clock";
import type { RuntimeEventBus } from "../../ports/runtime-event-bus";
import type { RuntimeStore } from "../../ports/runtime-store";
import type { RuntimeWorkloadPort, RuntimeWorkloadSpec } from "../../ports/runtime-workload-port";

export interface RuntimeCommandServiceDependencies {
  readonly clock: RuntimeClock;
  readonly cluster: string;
  readonly eventBus: RuntimeEventBus;
  readonly namespace: string;
  readonly runtimeImage: string;
  readonly runtimePort: number;
  readonly store: RuntimeStore;
  readonly ttlSeconds: number;
  readonly workload: RuntimeWorkloadPort;
  readonly workdirRoot: string;
}

export class RuntimeCommandService {
  private sequence = 0;

  constructor(private readonly dependencies: RuntimeCommandServiceDependencies) {}

  async createRuntime(input: { userId: string }): Promise<RuntimeSnapshot> {
    const existing = await this.dependencies.store.getByUserId(input.userId);
    if (existing && existing.status !== "terminated" && existing.status !== "terminating") {
      const runtime = RuntimeAggregate.rehydrate(existing);
      await this.extendLeaseAndPersist(runtime);
      return runtime.snapshot();
    }

    const runtime = RuntimeAggregate.create({
      cluster: this.dependencies.cluster,
      namespace: this.dependencies.namespace,
      now: this.dependencies.clock.now(),
      runtimeId: this.nextRuntimeId(),
      servicePort: this.dependencies.runtimePort,
      targetPort: this.dependencies.runtimePort,
      userId: input.userId,
      workspaceRootPath: buildRuntimeWorkspaceRoot(this.dependencies.workdirRoot, input.userId),
    });
    await this.publish(runtime);
    const reserved = await this.dependencies.store.tryCreateForUser(runtime.snapshot(), this.dependencies.ttlSeconds);
    if (!reserved) {
      const current = await this.dependencies.store.getByUserId(input.userId);
      if (current) {
        return current;
      }
      throw new Error(`runtime for user ${input.userId} is being created`);
    }

    let deploymentCreated = false;
    let serviceCreated = false;
    try {
      runtime.markScheduled();
      await this.publish(runtime);

      const capacity = await this.dependencies.workload.checkCapacity({
        cluster: this.dependencies.cluster,
        namespace: this.dependencies.namespace,
      });
      if (!capacity.allowed) {
        throw new Error(capacity.reason ?? "runtime capacity check failed");
      }

      const spec = this.buildWorkloadSpec(runtime.snapshot());
      await this.dependencies.workload.createDeployment(spec);
      deploymentCreated = true;
      runtime.markDeploymentCreated();
      await this.publish(runtime);

      await this.dependencies.workload.createService(spec);
      serviceCreated = true;
      runtime.markServiceCreated();
      await this.publish(runtime);

      await this.dependencies.workload.waitUntilReady(runtime.snapshot());
      runtime.markPodReady();
      await this.publish(runtime);

      runtime.markRunning();
      await this.publish(runtime);

      await this.extendLeaseAndPersist(runtime);
      return runtime.snapshot();
    } catch (error) {
      runtime.markFailed(error instanceof Error ? error.message : "runtime creation failed");
      await this.publish(runtime);
      await this.compensateCreateFailure(runtime.snapshot(), { deploymentCreated, serviceCreated });
      await this.dependencies.store.deleteByUserId(input.userId).catch(() => undefined);
      throw error;
    }
  }

  async restartRuntime(input: { userId: string; reason?: string }): Promise<RuntimeSnapshot> {
    const snapshot = await this.requireRuntime(input.userId);
    const runtime = RuntimeAggregate.rehydrate(snapshot);

    runtime.markRestarting(input.reason);
    await this.publish(runtime);

    await this.dependencies.workload.restartDeployment(runtime.snapshot());
    runtime.markPodReady();
    await this.publish(runtime);

    runtime.markRunning();
    await this.publish(runtime);

    await this.extendLeaseAndPersist(runtime);
    return runtime.snapshot();
  }

  async deleteRuntime(input: { userId: string }): Promise<void> {
    const snapshot = await this.requireRuntime(input.userId);
    const runtime = RuntimeAggregate.rehydrate(snapshot);

    runtime.markTerminating();
    await this.publish(runtime);

    await this.dependencies.workload.deleteDeployment(runtime.snapshot());
    await this.dependencies.workload.deleteService(runtime.snapshot());

    runtime.markTerminated();
    await this.publish(runtime);
    await this.dependencies.store.deleteByUserId(input.userId);
  }

  private async compensateCreateFailure(
    snapshot: RuntimeSnapshot,
    created: { deploymentCreated: boolean; serviceCreated: boolean },
  ): Promise<void> {
    if (created.serviceCreated) {
      await this.dependencies.workload.deleteService(snapshot).catch(() => undefined);
    }
    if (created.deploymentCreated) {
      await this.dependencies.workload.deleteDeployment(snapshot).catch(() => undefined);
    }
  }

  private async requireRuntime(userId: string): Promise<RuntimeSnapshot> {
    const snapshot = await this.dependencies.store.getByUserId(userId);
    if (!snapshot) {
      throw new RuntimeNotFoundError(userId);
    }
    return snapshot;
  }

  private async extendLeaseAndPersist(runtime: RuntimeAggregate): Promise<void> {
    runtime.extendLease(this.dependencies.clock.plusSeconds(this.dependencies.ttlSeconds));
    await this.publish(runtime);
    await this.dependencies.store.save(runtime.snapshot());
  }

  private async publish(runtime: RuntimeAggregate): Promise<void> {
    for (const event of runtime.pullEvents()) {
      await this.dependencies.eventBus.publish(event);
    }
  }

  private buildWorkloadSpec(runtime: RuntimeSnapshot): RuntimeWorkloadSpec {
    return {
      image: this.dependencies.runtimeImage,
      runtime,
    };
  }

  private nextRuntimeId(): string {
    this.sequence += 1;
    return `rt-${this.sequence.toString().padStart(6, "0")}`;
  }
}
