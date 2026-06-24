import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeWorkloadPort, RuntimeWorkloadSpec } from "../../ports/runtime-workload-port";

export class FakeRuntimeWorkloadAdapter implements RuntimeWorkloadPort {
  readonly createdDeployments: RuntimeWorkloadSpec[] = [];
  readonly createdServices: RuntimeWorkloadSpec[] = [];
  readonly readyRuntimes: string[] = [];
  readonly restartedDeployments: string[] = [];
  readonly deletedDeployments: string[] = [];
  readonly deletedServices: string[] = [];

  async createDeployment(spec: RuntimeWorkloadSpec): Promise<void> {
    this.createdDeployments.push(spec);
  }

  async createService(spec: RuntimeWorkloadSpec): Promise<void> {
    this.createdServices.push(spec);
  }

  async waitUntilReady(snapshot: RuntimeSnapshot): Promise<void> {
    this.readyRuntimes.push(snapshot.runtimeId);
  }

  async restartDeployment(snapshot: RuntimeSnapshot): Promise<void> {
    this.restartedDeployments.push(snapshot.deploymentName);
  }

  async deleteDeployment(snapshot: RuntimeSnapshot): Promise<void> {
    this.deletedDeployments.push(snapshot.deploymentName);
  }

  async deleteService(snapshot: RuntimeSnapshot): Promise<void> {
    this.deletedServices.push(snapshot.serviceName);
  }
}
