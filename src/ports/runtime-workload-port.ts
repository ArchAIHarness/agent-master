import type { RuntimeSnapshot } from "../domain/runtime/runtime";
import type { RuntimeSceneRegistry } from "../domain/runtime/runtime-policy";

export interface RuntimeWorkloadSpec {
  readonly runtime: RuntimeSnapshot;
  readonly image: string;
  readonly scenes: RuntimeSceneRegistry;
}

export interface RuntimeWorkloadPort {
  createDeployment(spec: RuntimeWorkloadSpec): Promise<void>;
  createService(spec: RuntimeWorkloadSpec): Promise<void>;
  waitUntilReady(snapshot: RuntimeSnapshot): Promise<void>;
  restartDeployment(snapshot: RuntimeSnapshot): Promise<void>;
  deleteDeployment(snapshot: RuntimeSnapshot): Promise<void>;
  deleteService(snapshot: RuntimeSnapshot): Promise<void>;
}
