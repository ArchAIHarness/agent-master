import type { RuntimeSnapshot } from "../domain/runtime/runtime";

export interface RuntimeWorkloadSpec {
  readonly runtime: RuntimeSnapshot;
  readonly image: string;
}

export interface RuntimeCapacityCheckInput {
  readonly cluster: string;
  readonly namespace: string;
}

export interface RuntimeCapacityCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface RuntimeWorkloadPort {
  checkCapacity(input: RuntimeCapacityCheckInput): Promise<RuntimeCapacityCheckResult>;
  createDeployment(spec: RuntimeWorkloadSpec): Promise<void>;
  createService(spec: RuntimeWorkloadSpec): Promise<void>;
  waitUntilReady(snapshot: RuntimeSnapshot): Promise<void>;
  restartDeployment(snapshot: RuntimeSnapshot): Promise<void>;
  deleteDeployment(snapshot: RuntimeSnapshot): Promise<void>;
  deleteService(snapshot: RuntimeSnapshot): Promise<void>;
}
