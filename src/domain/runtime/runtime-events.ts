import type { RuntimeStatus } from "./runtime-status";

export const runtimeEventTypes = [
  "runtime.creating",
  "runtime.scheduled",
  "runtime.deployment.created",
  "runtime.service.created",
  "runtime.pod.ready",
  "runtime.running",
  "runtime.restarting",
  "runtime.terminating",
  "runtime.terminated",
  "runtime.failed",
  "runtime.ttl.extended",
  "runtime.heartbeat",
] as const;

export type RuntimeEventType = (typeof runtimeEventTypes)[number];

export interface RuntimeEventPayload {
  readonly userId: string;
  readonly runtimeId?: string;
  readonly status?: RuntimeStatus;
  readonly cluster?: string;
  readonly namespace?: string;
  readonly deploymentName?: string;
  readonly serviceName?: string;
  readonly reason?: string;
  readonly leaseExpireAt?: string;
  readonly time: string;
}

export interface RuntimeEvent {
  readonly type: RuntimeEventType;
  readonly payload: RuntimeEventPayload;
}

export function createRuntimeEvent(type: RuntimeEventType, payload: Omit<RuntimeEventPayload, "time"> & { time?: string }): RuntimeEvent {
  return {
    type,
    payload: {
      ...payload,
      time: payload.time ?? new Date().toISOString(),
    },
  };
}
