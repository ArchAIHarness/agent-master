import { RuntimeNotRunningError } from "./runtime-errors";
import { createRuntimeEvent, type RuntimeEvent } from "./runtime-events";
import { buildRuntimeResourceName } from "./runtime-policy";
import type { RuntimeStatus } from "./runtime-status";

export interface RuntimeSnapshot {
  readonly runtimeId: string;
  readonly userId: string;
  readonly status: RuntimeStatus;
  readonly cluster: string;
  readonly namespace: string;
  readonly deploymentName: string;
  readonly serviceName: string;
  readonly podSelector: Record<string, string>;
  readonly servicePort: number;
  readonly targetPort: number;
  readonly workspaceRootPath: string;
  readonly leaseExpireAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRuntimeInput {
  readonly runtimeId: string;
  readonly userId: string;
  readonly cluster: string;
  readonly namespace: string;
  readonly servicePort: number;
  readonly targetPort: number;
  readonly workspaceRootPath: string;
  readonly now?: Date;
}

export class RuntimeAggregate {
  private events: RuntimeEvent[] = [];

  private constructor(private state: RuntimeSnapshot) {}

  static create(input: CreateRuntimeInput): RuntimeAggregate {
    const now = (input.now ?? new Date()).toISOString();
    const resourceName = buildRuntimeResourceName({ runtimeId: input.runtimeId });
    const aggregate = new RuntimeAggregate({
      cluster: input.cluster,
      createdAt: now,
      deploymentName: resourceName,
      namespace: input.namespace,
      podSelector: {
        app: "opencode-runtime",
        runtimeId: input.runtimeId,
        userId: input.userId,
      },
      runtimeId: input.runtimeId,
      serviceName: resourceName,
      servicePort: input.servicePort,
      status: "pending",
      targetPort: input.targetPort,
      updatedAt: now,
      userId: input.userId,
      workspaceRootPath: input.workspaceRootPath,
    });
    aggregate.record("runtime.creating");
    return aggregate;
  }

  static rehydrate(snapshot: RuntimeSnapshot): RuntimeAggregate {
    return new RuntimeAggregate(snapshot);
  }

  snapshot(): RuntimeSnapshot {
    return { ...this.state, podSelector: { ...this.state.podSelector } };
  }

  pullEvents(): RuntimeEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  markScheduled(): void {
    this.transition("preparing", "runtime.scheduled");
  }

  markDeploymentCreated(): void {
    this.record("runtime.deployment.created");
  }

  markServiceCreated(): void {
    this.record("runtime.service.created");
  }

  markPodReady(): void {
    this.record("runtime.pod.ready");
  }

  markRunning(): void {
    this.transition("running", "runtime.running");
  }

  markRestarting(reason?: string): void {
    if (this.state.status !== "running") {
      throw new RuntimeNotRunningError(this.state.runtimeId);
    }
    this.record("runtime.restarting", reason);
  }

  markTerminating(): void {
    this.transition("terminating", "runtime.terminating");
  }

  markTerminated(): void {
    this.transition("terminated", "runtime.terminated");
  }

  markFailed(reason: string): void {
    this.transition("failed", "runtime.failed", reason);
  }

  extendLease(leaseExpireAt: Date): void {
    this.state = {
      ...this.state,
      leaseExpireAt: leaseExpireAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.record("runtime.ttl.extended");
  }

  private transition(status: RuntimeStatus, eventType: RuntimeEvent["type"], reason?: string): void {
    this.state = {
      ...this.state,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.record(eventType, reason);
  }

  private record(type: RuntimeEvent["type"], reason?: string): void {
    this.events.push(
      createRuntimeEvent(type, {
        cluster: this.state.cluster,
        deploymentName: this.state.deploymentName,
        namespace: this.state.namespace,
        ...(reason ? { reason } : {}),
        runtimeId: this.state.runtimeId,
        serviceName: this.state.serviceName,
        status: this.state.status,
        userId: this.state.userId,
      }),
    );
  }
}
