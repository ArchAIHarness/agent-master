import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeStatus } from "../../domain/runtime/runtime-status";

export interface RuntimeResponse {
  readonly runtimeId: string;
  readonly userId: string;
  readonly status: RuntimeStatus;
  readonly cluster: string;
  readonly namespace: string;
  readonly deploymentName: string;
  readonly serviceName: string;
  readonly leaseExpireAt?: string;
}

export function toRuntimeResponse(snapshot: RuntimeSnapshot): RuntimeResponse {
  return {
    cluster: snapshot.cluster,
    deploymentName: snapshot.deploymentName,
    ...(snapshot.leaseExpireAt ? { leaseExpireAt: snapshot.leaseExpireAt } : {}),
    namespace: snapshot.namespace,
    runtimeId: snapshot.runtimeId,
    serviceName: snapshot.serviceName,
    status: snapshot.status,
    userId: snapshot.userId,
  };
}
