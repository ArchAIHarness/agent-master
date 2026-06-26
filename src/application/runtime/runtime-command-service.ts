import { RuntimeAggregate, type RuntimeSnapshot } from "../../domain/runtime/runtime";
import { RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";
import { buildRuntimeWorkspaceRoot } from "../../domain/runtime/runtime-policy";
import type { RuntimeClock } from "../../domain/runtime/runtime-clock";
import type { RuntimeEventBus } from "../../domain/runtime/runtime-event-bus";

import type { RuntimeStore } from "../../domain/runtime/runtime-store";
import type { RuntimeWorkloadPort, RuntimeWorkloadSpec } from "../../domain/runtime/runtime-workload-port";

export interface RuntimeCommandServiceDependencies {
  readonly clock: RuntimeClock;
  readonly cluster: string;
  readonly eventBus: RuntimeEventBus;
  readonly namespace: string;
  readonly runtimeImage: string;
  readonly runtimePort: number;
  readonly opencodePort: number;
  readonly store: RuntimeStore;
  readonly templatesRoot: string;
  readonly ttlSeconds: number;
  readonly workload: RuntimeWorkloadPort;
  readonly workdirRoot: string;
  readonly webuiDomainTemplate?: string;
}

export class RuntimeCommandService {
  constructor(private readonly dependencies: RuntimeCommandServiceDependencies) {}

  private generateRuntimeId(userId: string): string {
    // Sanitize userId for Kubernetes name compatibility:
    // - Kubernetes only allows lowercase letters, digits, '-', must not start/end with '-'
    // - Add 4 random chars to avoid collision if same user creates multiple times
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let random = "";
    for (let i = 0; i < 4; i++) {
      random += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const sanitizedUserId = userId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!sanitizedUserId) {
      return `rt-${random}`;
    }
    return `rt-${sanitizedUserId}-${random}`;
  }

  async createRuntime(input: { userId: string }): Promise<RuntimeSnapshot> {
    const existing = await this.dependencies.store.getByUserId(input.userId);
    if (existing && existing.status !== "terminated" && existing.status !== "terminating") {
      const runtime = RuntimeAggregate.rehydrate(existing);
      await this.extendLeaseAndPersist(runtime);
      return runtime.snapshot();
    }

    const runtimeId = this.generateRuntimeId(input.userId);
    const runtime = RuntimeAggregate.create({
      cluster: this.dependencies.cluster,
      namespace: this.dependencies.namespace,
      now: this.dependencies.clock.now(),
      opencodePort: this.dependencies.opencodePort,
      runtimeId,
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

       // 用户工作目录由 runtime pod 的 initContainer 初始化
       // agent-master 不挂载 NAS，不碰文件系统
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

}
