import { describe, expect, test } from "bun:test";

import { RuntimeCommandService } from "../src/application/runtime/runtime-command-service";
import { isOpenCodeSseProxyPath, RuntimeAgentProxyService } from "../src/application/runtime/runtime-agent-proxy-service";
import { RuntimeEventStreamService } from "../src/application/runtime/runtime-event-stream-service";
import { RuntimeQueryService } from "../src/application/runtime/runtime-query-service";
import { InMemoryRuntimeEventBus } from "../src/infrastructure/fake/in-memory-runtime-event-bus";
import { InMemoryRuntimeStore } from "../src/infrastructure/fake/in-memory-runtime-store";
import { FakeRuntimeAgentProxy } from "../src/infrastructure/fake/fake-runtime-agent-proxy";
import type { RuntimeSnapshot } from "../src/domain/runtime/runtime";
import { FakeRuntimeWorkloadAdapter } from "../src/infrastructure/fake/fake-runtime-workload-adapter";
import type { RuntimeWorkloadPort, RuntimeWorkloadSpec } from "../src/ports/runtime-workload-port";
import { FixedRuntimeClock } from "../src/infrastructure/fake/fixed-runtime-clock";

function buildServices() {
  const eventBus = new InMemoryRuntimeEventBus();
  const store = new InMemoryRuntimeStore();
  const workload = new FakeRuntimeWorkloadAdapter();
  const clock = new FixedRuntimeClock(new Date("2026-06-12T00:00:00.000Z"));
  const scenes = {
    coding: "/nas/agent-control/scenes/coding",
    review: "/nas/agent-control/scenes/review",
  };
  const commandService = new RuntimeCommandService({
    clock,
    cluster: "default",
    eventBus,
    namespace: "agent-runtime",
    runtimeImage: "ghcr.io/archaiharness/agent-runtime:latest",
    runtimePort: 4096,
    scenes,
    store,
    ttlSeconds: 3600,
    workload,
    workdirRoot: "/nas/agent-control/users",
  });
  const queryService = new RuntimeQueryService({ store });
  const agentProxy = new FakeRuntimeAgentProxy();
  const proxyService = new RuntimeAgentProxyService({
    clock,
    eventBus,
    proxy: agentProxy,
    scenes,
    store,
    ttlSeconds: 3600,
  });
  const eventStreamService = new RuntimeEventStreamService({
    clock,
    eventBus,
    store,
    ttlSeconds: 3600,
  });

  return { agentProxy, commandService, eventBus, eventStreamService, proxyService, queryService, store, workload };
}

describe("Runtime application services", () => {
  test("identifies OpenCode native SSE proxy paths", () => {
    expect(isOpenCodeSseProxyPath("/event")).toBe(true);
    expect(isOpenCodeSseProxyPath("/global/event")).toBe(true);
    expect(isOpenCodeSseProxyPath("/session")).toBe(false);
  });
  test("creates runtime through event-driven workflow and persists running state", async () => {
    const { commandService, eventBus, queryService, workload } = buildServices();

    const runtime = await commandService.createRuntime({ userId: "user-a" });
    const queried = await queryService.getRuntime({ userId: "user-a" });

    expect(runtime.status).toBe("running");
    expect(queried?.runtimeId).toBe(runtime.runtimeId);
    expect(workload.createdDeployments).toHaveLength(1);
    expect(workload.createdServices).toHaveLength(1);
    expect(eventBus.published.map((event) => event.type)).toEqual([
      "runtime.creating",
      "runtime.scheduled",
      "runtime.deployment.created",
      "runtime.service.created",
      "runtime.pod.ready",
      "runtime.running",
      "runtime.ttl.extended",
    ]);
  });

  test("reuses existing runtime and emits ttl extension event", async () => {
    const { commandService, eventBus } = buildServices();
    const first = await commandService.createRuntime({ userId: "user-a" });
    eventBus.clear();

    const second = await commandService.createRuntime({ userId: "user-a" });

    expect(second.runtimeId).toBe(first.runtimeId);
    expect(eventBus.published.map((event) => event.type)).toEqual(["runtime.ttl.extended"]);
  });

  test("restarts existing runtime without changing service mapping", async () => {
    const { commandService, eventBus, queryService, workload } = buildServices();
    const runtime = await commandService.createRuntime({ userId: "user-a" });
    eventBus.clear();

    const restarted = await commandService.restartRuntime({ reason: "reload-opencode-config", userId: "user-a" });
    const queried = await queryService.getRuntime({ userId: "user-a" });

    expect(restarted.runtimeId).toBe(runtime.runtimeId);
    expect(queried?.serviceName).toBe(runtime.serviceName);
    expect(workload.restartedDeployments).toEqual([runtime.deploymentName]);
    expect(eventBus.published.map((event) => event.type)).toEqual([
      "runtime.restarting",
      "runtime.pod.ready",
      "runtime.running",
      "runtime.ttl.extended",
    ]);
  });

  test("emits heartbeat without binding each heartbeat to TTL renewal", async () => {
    const { commandService, eventBus, eventStreamService, queryService } = buildServices();
    await commandService.createRuntime({ userId: "user-a" });
    eventBus.clear();

    const heartbeat = await eventStreamService.heartbeat({ userId: "user-a" });

    expect(heartbeat.type).toBe("runtime.heartbeat");
    expect((await queryService.getRuntime({ userId: "user-a" }))?.leaseExpireAt).toBe("2026-06-12T01:00:00.000Z");
    expect(eventBus.published.map((event) => event.type)).toEqual([]);
  });

  test("renews runtime lease through independent platform event stream interval", async () => {
    const { commandService, eventBus, eventStreamService, queryService } = buildServices();
    await commandService.createRuntime({ userId: "user-a" });
    eventBus.clear();

    await eventStreamService.renewLease({ userId: "user-a" });

    expect((await queryService.getRuntime({ userId: "user-a" }))?.leaseExpireAt).toBe("2026-06-12T01:00:00.000Z");
    expect(eventBus.published.map((event) => event.type)).toEqual(["runtime.ttl.extended"]);
  });

  test("compensates deployment when service creation fails", async () => {
    const eventBus = new InMemoryRuntimeEventBus();
    const store = new InMemoryRuntimeStore();
    const workload = new ServiceFailingWorkloadAdapter();
    const commandService = new RuntimeCommandService({
      clock: new FixedRuntimeClock(new Date("2026-06-12T00:00:00.000Z")),
      cluster: "default",
      eventBus,
      namespace: "agent-runtime",
      runtimeImage: "ghcr.io/archaiharness/agent-runtime:latest",
      runtimePort: 4096,
      scenes: { coding: "/nas/agent-control/scenes/coding" },
      store,
      ttlSeconds: 3600,
      workload,
      workdirRoot: "/nas/agent-control/users",
    });

    await expect(commandService.createRuntime({ userId: "user-a" })).rejects.toThrow("service creation failed");

    expect(workload.deletedDeployments).toEqual(["opencode-rt-000001"]);
    expect(eventBus.published.map((event) => event.type)).toContain("runtime.failed");
  });

  test("deletes runtime by emitting terminating and terminated events", async () => {
    const { commandService, eventBus, queryService, workload } = buildServices();
    const runtime = await commandService.createRuntime({ userId: "user-a" });
    eventBus.clear();

    await commandService.deleteRuntime({ userId: "user-a" });
    const queried = await queryService.getRuntime({ userId: "user-a" });

    expect(queried).toBeNull();
    expect(workload.deletedDeployments).toEqual([runtime.deploymentName]);
    expect(workload.deletedServices).toEqual([runtime.serviceName]);
    expect(eventBus.published.map((event) => event.type)).toEqual([
      "runtime.terminating",
      "runtime.terminated",
    ]);
  });

  test("proxies session creation by converting scene into directory, stripping authorization and extending lease", async () => {
    const { agentProxy, commandService, eventBus, proxyService, queryService } = buildServices();
    await commandService.createRuntime({ userId: "user-a" });
    eventBus.clear();

    const response = await proxyService.proxy({
      body: { agent: "build", scene: "coding", title: "hello" },
      headers: { authorization: "Bearer secret", "x-custom": "safe" },
      method: "POST",
      path: "/session",
      query: {},
      userId: "user-a",
    });

    expect(response.statusCode).toBe(200);
    expect(agentProxy.requests[0]).toMatchObject({
      body: { agent: "build", title: "hello" },
      headers: { "x-custom": "safe" },
      method: "POST",
      path: "/session",
      query: { directory: "/app/coding" },
    });
    expect((await queryService.getRuntime({ userId: "user-a" }))?.leaseExpireAt).toBe("2026-06-12T01:00:00.000Z");
    expect(eventBus.published.map((event) => event.type)).toEqual(["runtime.ttl.extended"]);
  });
});

class ServiceFailingWorkloadAdapter implements RuntimeWorkloadPort {
  readonly deletedDeployments: string[] = [];

  async checkCapacity(): Promise<{ allowed: boolean }> {
    return { allowed: true };
  }

  async createDeployment(_spec: RuntimeWorkloadSpec): Promise<void> {
    return;
  }

  async createService(_spec: RuntimeWorkloadSpec): Promise<void> {
    throw new Error("service creation failed");
  }

  async waitUntilReady(_snapshot: RuntimeSnapshot): Promise<void> {
    return;
  }

  async restartDeployment(_snapshot: RuntimeSnapshot): Promise<void> {
    return;
  }

  async deleteDeployment(snapshot: RuntimeSnapshot): Promise<void> {
    this.deletedDeployments.push(snapshot.deploymentName);
  }

  async deleteService(_snapshot: RuntimeSnapshot): Promise<void> {
    return;
  }
}
