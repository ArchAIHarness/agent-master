import { describe, expect, test } from "bun:test";

import { buildApp } from "../src/app";
import type { RuntimeEvent } from "../src/domain/runtime/runtime-events";
import { FakeRuntimeAgentProxy } from "../src/infrastructure/fake/fake-runtime-agent-proxy";
import { FakeRuntimeWorkloadAdapter } from "../src/infrastructure/fake/fake-runtime-workload-adapter";
import { FixedRuntimeClock } from "../src/infrastructure/fake/fixed-runtime-clock";
import { InMemoryRuntimeEventBus } from "../src/infrastructure/fake/in-memory-runtime-event-bus";
import { InMemoryRuntimeStore } from "../src/infrastructure/fake/in-memory-runtime-store";

function buildRuntimeApp() {
  const eventBus = new InMemoryRuntimeEventBus();
  const store = new InMemoryRuntimeStore();
  const workload = new FakeRuntimeWorkloadAdapter();
  const proxy = new FakeRuntimeAgentProxy();
  const app = buildApp({
    config: {
      clusters: [],
      host: "0.0.0.0",
      logLevel: "silent",
      port: 3000,
    },
    runtime: {
      clock: new FixedRuntimeClock(new Date("2026-06-12T00:00:00.000Z")),
      cluster: "default",
      eventBus,
      namespace: "agent-runtime",
      proxy,
      runtimeImage: "ghcr.io/archaiharness/agent-runtime:latest",
      runtimePort: 4096,
      scenes: {
        coding: "/nas/agent-control/scenes/coding",
        review: "/nas/agent-control/scenes/review",
      },
      store,
      ttlSeconds: 3600,
      workload,
      workdirRoot: "/nas/agent-control/users",
    },
  });
  return { app, eventBus, proxy, store, workload };
}

describe("runtime HTTP API", () => {
  test("rejects unsafe x-user-id before building NAS path", async () => {
    const { app } = buildRuntimeApp();

    const response = await app.inject({
      headers: { "x-user-id": "../../other" },
      method: "POST",
      url: "/api/v1/runtime",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_USER_ID" });
    await app.close();
  });

  test("rejects runtime creation without x-user-id", async () => {
    const { app } = buildRuntimeApp();

    const response = await app.inject({ method: "POST", url: "/api/v1/runtime" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "MISSING_USER_ID" });
    await app.close();
  });

  test("creates, queries, restarts and deletes current user runtime", async () => {
    const { app } = buildRuntimeApp();

    const createResponse = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime",
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({
      status: "running",
      userId: "user-a",
    });
    expect(createResponse.json()).not.toHaveProperty("workspaceRootPath");

    const getResponse = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime",
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      status: "running",
      userId: "user-a",
    });

    const restartResponse = await app.inject({
      body: { reason: "reload-opencode-config" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/restart",
    });
    expect(restartResponse.statusCode).toBe(200);
    expect(restartResponse.json()).toMatchObject({
      status: "running",
      userId: "user-a",
    });

    const deleteResponse = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "DELETE",
      url: "/api/v1/runtime",
    });
    expect(deleteResponse.statusCode).toBe(204);

    const missingResponse = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime",
    });
    expect(missingResponse.statusCode).toBe(404);
    await app.close();
  });

  test("returns platform runtime events as SSE payload", async () => {
    const { app } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const response = await app.inject({
      headers: { "x-sse-test-once": "true", "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/events",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: runtime.heartbeat");
    expect(response.body).toContain("data:");
    await app.close();
  });

  test("proxies OpenCode session with scene conversion and without authorization", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const response = await app.inject({
      body: { agent: "build", scene: "coding", title: "work" },
      headers: { authorization: "Bearer secret", "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/agent/session",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      body: { agent: "build", title: "work" },
      headers: { "x-user-id": "user-a" },
      path: "/session",
      query: { directory: "/app/coding" },
    });
    await app.close();
  });

  test("preserves repeated OpenCode query parameters for transparent proxy", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/agent/event?workspace=a&workspace=b&plain=ok",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]?.query).toEqual({
      plain: "ok",
      workspace: ["a", "b"],
    });
    await app.close();
  });

  test("rejects unknown session scene", async () => {
    const { app } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const response = await app.inject({
      body: { scene: "unknown" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/agent/session",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "UNKNOWN_RUNTIME_SCENE" });
    await app.close();
  });
});

describe("runtime event bus", () => {
  test("subscribers receive runtime lifecycle events", async () => {
    const { app, eventBus } = buildRuntimeApp();
    const received: RuntimeEvent[] = [];
    const unsubscribe = eventBus.subscribe("user-a", (event) => {
      received.push(event);
    });

    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    unsubscribe();
    expect(received.map((event) => event.type)).toContain("runtime.running");
    await app.close();
  });
});
