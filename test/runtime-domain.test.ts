import { describe, expect, test } from "bun:test";

import { RuntimeAggregate } from "../src/domain/runtime/runtime";
import { RuntimeNotRunningError, UnknownRuntimeSceneError } from "../src/domain/runtime/runtime-errors";
import type { RuntimeSceneRegistry } from "../src/domain/runtime/runtime-policy";

const scenes: RuntimeSceneRegistry = {
  coding: "/nas/agent-master/scenes/coding",
  review: "/nas/agent-master/scenes/review",
};

describe("RuntimeAggregate", () => {
  test("creates a user-owned runtime and records lifecycle events", () => {
    const runtime = RuntimeAggregate.create({
      cluster: "cluster-a",
      namespace: "agent-runtime",
      runtimeId: "rt-abc123",
      servicePort: 4096,
      targetPort: 4096,
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
      deploymentName: "opencode-rt-abc123",
      serviceName: "opencode-rt-abc123",
      servicePort: 4096,
      targetPort: 4096,
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
      runtimeId: "rt-delete",
      servicePort: 4096,
      targetPort: 4096,
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
      runtimeId: "rt-pending",
      servicePort: 4096,
      targetPort: 4096,
      userId: "user-pending",
      workspaceRootPath: "/nas/agent-master/users/user-pending",
    });

    expect(() => runtime.markRestarting("reload-opencode-config")).toThrow(RuntimeNotRunningError);
  });

  test("converts a known scene into an OpenCode directory", () => {
    const directory = RuntimeAggregate.resolveSceneDirectory({ scene: "coding", scenes });

    expect(directory).toBe("/app/coding");
  });

  test("rejects unknown scene before building OpenCode directory", () => {
    expect(() => RuntimeAggregate.resolveSceneDirectory({ scene: "../../etc", scenes })).toThrow(UnknownRuntimeSceneError);
  });
});
