import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

import { buildApp } from "../src/app";
import { FakeRuntimeAgentProxy } from "../src/infrastructure/fake/fake-runtime-agent-proxy";
import { FakeRuntimeAgentWebSocketProxy } from "../src/infrastructure/fake/fake-runtime-agent-websocket-proxy";
import { NoopUserWorkspaceInitializer } from "../src/infrastructure/fake/noop-user-workspace-initializer";
import { FakeRuntimeWorkloadAdapter } from "../src/infrastructure/fake/fake-runtime-workload-adapter";
import { FixedRuntimeClock } from "../src/infrastructure/fake/fixed-runtime-clock";
import { InMemoryRuntimeEventBus } from "../src/infrastructure/fake/in-memory-runtime-event-bus";
import { InMemoryRuntimeStore } from "../src/infrastructure/fake/in-memory-runtime-store";

function buildRuntimeApp() {
  const eventBus = new InMemoryRuntimeEventBus();
  const store = new InMemoryRuntimeStore();
  const workload = new FakeRuntimeWorkloadAdapter();
  const proxy = new FakeRuntimeAgentProxy();
  const websocket = new FakeRuntimeAgentWebSocketProxy();
  const userWorkspaceInitializer = new NoopUserWorkspaceInitializer();
  const app = buildApp({
    config: {
      host: "0.0.0.0",
      logLevel: "silent",
      port: 0,
    },
    runtime: {
      clock: new FixedRuntimeClock(new Date("2026-06-12T00:00:00.000Z")),
      cluster: "default",
      eventBus,
      namespace: "agent-runtime",
      proxy,
      runtimeImage: "ghcr.io/archaiharness/agent-runtime:latest",
      runtimePort: 4096,
      store,
      templatesRoot: "./resources/templates",
      ttlSeconds: 3600,
      userWorkspaceInitializer,
      websocket,
      workload,
      workdirRoot: "/nas/agent-master/users",
    },
  });
  return { app, websocket };
}

async function listen(app: ReturnType<typeof buildRuntimeApp>["app"]): Promise<{ host: string; port: number }> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  return { host: address.address, port: address.port };
}

async function closeApp(app: ReturnType<typeof buildRuntimeApp>["app"]): Promise<void> {
  // Fastify + @fastify/websocket can hang on shutdown under bun:test when websocket
  // server clients linger. We race close with a timeout to keep tests deterministic.
  await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 500))]);
}

async function ensureRuntime(app: ReturnType<typeof buildRuntimeApp>["app"], userId: string): Promise<void> {
  const response = await app.inject({ headers: { "x-user-id": userId }, method: "POST", url: "/runtime" });
  if (response.statusCode !== 201 && response.statusCode !== 200) {
    throw new Error(`failed to ensure runtime for ${userId}: ${response.statusCode}`);
  }
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const finalize = (code: number, reason: Buffer | string): void => {
      resolve({ code, reason: typeof reason === "string" ? reason : reason.toString("utf8") });
    };
    ws.on("close", finalize);
    ws.on("error", () => {
      finalize(1006, "");
    });
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}

describe("agent websocket proxy", () => {
  test("forwards WebSocket frames between downstream and Agent service", async () => {
    const { app, websocket } = buildRuntimeApp();
    const { host, port } = await listen(app);
    await ensureRuntime(app, "user-a");

    const client = new WebSocket(`ws://${host}:${port}/agent/ws/pty/pty-1/connect?x-user-id=user-a&cols=80`);
    const receivedFromClient: Buffer[] = [];
    client.on("message", (data) => {
      receivedFromClient.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    await waitOpen(client);

    // wait for the master to invoke the upstream factory
    await new Promise((resolve) => setTimeout(resolve, 30));
    const upstream = websocket.connections[0];
    expect(upstream).toBeDefined();
    if (!upstream) {
      client.close();
      await closeApp(app);
      return;
    }

    expect(upstream.request.path).toBe("/pty/pty-1/connect");
    expect(upstream.request.query).toMatchObject({ cols: "80" });
    expect(upstream.request.query).not.toHaveProperty("x-user-id");
    expect(upstream.request.headers).not.toHaveProperty("authorization");
    expect(upstream.request.headers).not.toHaveProperty("upgrade");
    expect(upstream.request.headers).not.toHaveProperty("sec-websocket-key");

    upstream.triggerOpen();
    upstream.triggerMessage(Buffer.from("hello downstream", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(receivedFromClient.length).toBe(1);
    expect(receivedFromClient[0]?.toString("utf8")).toBe("hello downstream");

    client.send(Buffer.from("typed input", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(upstream.sent.length).toBe(1);
    const firstSent = upstream.sent[0];
    expect(Buffer.isBuffer(firstSent) ? firstSent.toString("utf8") : firstSent).toBe("typed input");

    const closing = waitClose(client);
    upstream.triggerClose(1000, "agent done");
    await closing;
    await closeApp(app);
  });

  test("rejects unknown websocket paths", async () => {
    const { app, websocket } = buildRuntimeApp();
    const { host, port } = await listen(app);
    await ensureRuntime(app, "user-a");

    const client = new WebSocket(`ws://${host}:${port}/agent/ws/random/path?x-user-id=user-a`);
    const closed = waitClose(client);
    const result = await closed;
    expect(result.code).toBe(1008);
    expect(websocket.connections.length).toBe(0);

    await closeApp(app);
  });

  test("rejects missing x-user-id", async () => {
    const { app, websocket } = buildRuntimeApp();
    const { host, port } = await listen(app);
    await ensureRuntime(app, "user-a");

    const client = new WebSocket(`ws://${host}:${port}/agent/ws/pty/pty-1/connect`);
    const closed = waitClose(client);
    const result = await closed;
    expect(result.code).toBe(1008);
    expect(websocket.connections.length).toBe(0);

    await closeApp(app);
  });

  test("rejects when runtime is not running", async () => {
    const { app, websocket } = buildRuntimeApp();
    const { host, port } = await listen(app);

    const client = new WebSocket(`ws://${host}:${port}/agent/ws/pty/pty-1/connect?x-user-id=user-a`);
    const closed = waitClose(client);
    const result = await closed;
    expect(result.code).toBe(1008);
    expect(websocket.connections.length).toBe(0);

    await closeApp(app);
  });

  test("supports x-user-id via Sec-WebSocket-Protocol subprotocol and strips it before upstream", async () => {
    const { app, websocket } = buildRuntimeApp();
    const { host, port } = await listen(app);
    await ensureRuntime(app, "user-a");

    const client = new WebSocket(
      `ws://${host}:${port}/agent/ws/pty/pty-1/connect`,
      ["x-user-id.user-a", "opencode.shell"],
    );
    await waitOpen(client);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const upstream = websocket.connections[0];
    expect(upstream).toBeDefined();
    expect(upstream?.request.subprotocols ?? []).not.toContain("x-user-id.user-a");
    expect(upstream?.request.subprotocols ?? []).toContain("opencode.shell");

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await closeApp(app);
  });
});
