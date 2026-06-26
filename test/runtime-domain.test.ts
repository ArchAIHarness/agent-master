import { describe, expect, test } from "bun:test";

import { RuntimeAggregate } from "../src/domain/runtime/runtime";
import { RuntimeNotRunningError } from "../src/domain/runtime/runtime-errors";

describe("RuntimeAggregate", () => {
  test("creates a user-owned runtime and records lifecycle events", () => {
    const runtime = RuntimeAggregate.create({
      cluster: "cluster-a",
      namespace: "agent-runtime",
      opencodePort: 4096,
      runtimeId: "rt-abc123",
      servicePort: 8080,
      targetPort: 8080,
      userId: "user-a",
      workspaceRootPath: "/nas/agent-master/users/user-a",
    });

    runtime.markScheduled();
    runtime.markDeploymentCreated();
    runtime.markServiceCreated();
    runtime.markPodReady();
    runtime.markRunning();

    expect(runtime.snapshot()).toMatchObject({
      runtimeId: "rt-abc123",
      userId: "user-a",
      status: "running",
      deploymentName: "agent-rt-abc123",
      serviceName: "agent-rt-abc123",
      opencodePort: 4096,
      servicePort: 8080,
      targetPort: 8080,
      workspaceRootPath: "/nas/agent-master/users/user-a",
    });
    expect(runtime.pullEvents().map((event) => event.type)).toEqual([
      "runtime.creating",
      "runtime.scheduled",
      "runtime.deployment.created",
      "runtime.service.created",
      "runtime.pod.ready",
      "runtime.running",
    ]);
  });

  test("terminates a running runtime through events", () => {
    const runtime = RuntimeAggregate.create({
      cluster: "cluster-a",
      namespace: "agent-runtime",
      opencodePort: 4096,
      runtimeId: "rt-delete",
      servicePort: 8080,
      targetPort: 8080,
      userId: "user-delete",
      workspaceRootPath: "/nas/agent-master/users/user-delete",
    });
    runtime.markRunning();
    runtime.pullEvents();

    runtime.markTerminating();
    runtime.markTerminated();

    expect(runtime.snapshot().status).toBe("terminated");
    expect(runtime.pullEvents().map((event) => event.type)).toEqual([
      "runtime.terminating",
      "runtime.terminated",
    ]);
  });

  test("rejects restart when runtime is not running", () => {
    const runtime = RuntimeAggregate.create({
      cluster: "cluster-a",
      namespace: "agent-runtime",
      opencodePort: 4096,
      runtimeId: "rt-pending",
      servicePort: 8080,
      targetPort: 8080,
      userId: "user-pending",
      workspaceRootPath: "/nas/agent-master/users/user-pending",
    });

    expect(() => runtime.markRestarting("reload-opencode-config")).toThrow(RuntimeNotRunningError);
  });

});
