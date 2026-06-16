import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";

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
        coding: "/nas/agent-master/scenes/coding",
        review: "/nas/agent-master/scenes/review",
      },
      store,
      ttlSeconds: 3600,
      workload,
      workdirRoot: "/nas/agent-master/users",
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
      url: "/runtime",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_USER_ID" });
    await app.close();
  });

  test("rejects runtime creation without x-user-id", async () => {
    const { app } = buildRuntimeApp();

    const response = await app.inject({ method: "POST", url: "/runtime" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "MISSING_USER_ID" });
    await app.close();
  });

  test("creates, queries, restarts and deletes current user runtime", async () => {
    const { app } = buildRuntimeApp();

    const createResponse = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/runtime",
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
      url: "/runtime",
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
      url: "/runtime/restart",
    });
    expect(restartResponse.statusCode).toBe(200);
    expect(restartResponse.json()).toMatchObject({
      status: "running",
      userId: "user-a",
    });

    const deleteResponse = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "DELETE",
      url: "/runtime",
    });
    expect(deleteResponse.statusCode).toBe(204);

    const missingResponse = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/runtime",
    });
    expect(missingResponse.statusCode).toBe(404);
    await app.close();
  });

  test("returns platform runtime events as SSE payload", async () => {
    const { app } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });

    const response = await app.inject({
      headers: { "x-sse-test-once": "true", "x-user-id": "user-a" },
      method: "GET",
      url: "/runtime/events",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: runtime.heartbeat");
    expect(response.body).toContain("data:");
    await app.close();
  });

  test("proxies OpenCode session with scene conversion and without authorization", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });

    const response = await app.inject({
      body: { agent: "build", scene: "coding", title: "work" },
      headers: { authorization: "Bearer secret", "x-user-id": "user-a" },
      method: "POST",
      url: "/agent/session",
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
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/agent/event?workspace=a&workspace=b&plain=ok",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]?.query).toEqual({
      plain: "ok",
      workspace: ["a", "b"],
    });
    await app.close();
  });

  test("does not forward upstream authorization or hop-by-hop headers to Agent", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });

    const response = await app.inject({
      headers: {
        authorization: "Bearer user-secret",
        connection: "upgrade",
        "proxy-authorization": "Basic proxy-secret",
        te: "trailers",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        "x-user-id": "user-a",
      },
      method: "GET",
      url: "/agent/project/current",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({ path: "/project/current" });
    expect(proxy.requests[0]?.headers).toMatchObject({ "x-user-id": "user-a" });
    expect(proxy.requests[0]?.headers).not.toHaveProperty("authorization");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("connection");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("proxy-authorization");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("te");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("transfer-encoding");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("upgrade");
    await app.close();
  });

  test("does not forward upstream hop-by-hop or body length headers for JSON proxy responses", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });
    proxy.response = {
      body: { ok: true },
      headers: {
        connection: "keep-alive",
        "content-length": "12",
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      statusCode: 200,
    };

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/agent/session/ses_test/message",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).not.toHaveProperty("transfer-encoding");
    expect(response.headers).not.toHaveProperty("content-length", "12");
    expect(response.headers).not.toHaveProperty("connection");
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    await app.close();
  });

  test("serves JSON proxy responses over real HTTP without invalid chunk framing", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });
    proxy.response = {
      body: { ok: true },
      headers: {
        "content-length": "12",
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      statusCode: 200,
    };
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/agent/session/ses_test/message`, {
      headers: { "x-user-id": "user-a" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("12");
    expect(await response.json()).toEqual({ ok: true });
    await app.close();
  });

  test("rejects unknown session scene", async () => {
    const { app } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });

    const response = await app.inject({
      body: { scene: "unknown" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/agent/session",
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

    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });

    unsubscribe();
    expect(received.map((event) => event.type)).toContain("runtime.running");
    await app.close();
  });
});
