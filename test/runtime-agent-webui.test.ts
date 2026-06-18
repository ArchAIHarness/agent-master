import { describe, expect, test } from "bun:test";

import { buildApp } from "../src/app";
import { RuntimeAgentWebuiProxyService } from "../src/application/runtime/runtime-agent-webui-proxy-service";
import { FakeRuntimeAgentProxy } from "../src/infrastructure/fake/fake-runtime-agent-proxy";
import { NoopUserWorkspaceInitializer } from "../src/infrastructure/fake/noop-user-workspace-initializer";
import { FakeRuntimeWorkloadAdapter } from "../src/infrastructure/fake/fake-runtime-workload-adapter";
import { FixedRuntimeClock } from "../src/infrastructure/fake/fixed-runtime-clock";
import { InMemoryRuntimeEventBus } from "../src/infrastructure/fake/in-memory-runtime-event-bus";
import { InMemoryRuntimeStore } from "../src/infrastructure/fake/in-memory-runtime-store";

function buildRuntimeApp(options: { agentWebuiPort?: number; agentWebuiPathPrefix?: string } = {}) {
  const eventBus = new InMemoryRuntimeEventBus();
  const store = new InMemoryRuntimeStore();
  const workload = new FakeRuntimeWorkloadAdapter();
  const proxy = new FakeRuntimeAgentProxy();
  const userWorkspaceInitializer = new NoopUserWorkspaceInitializer();
  const clock = new FixedRuntimeClock(new Date("2026-06-12T00:00:00.000Z"));
  const app = buildApp({
    config: {
      clusters: [],
      host: "0.0.0.0",
      logLevel: "silent",
      port: 0,
    },
    runtime: {
      agentWebuiPathPrefix: options.agentWebuiPathPrefix ?? "/webui",
      ...(options.agentWebuiPort === undefined ? {} : { agentWebuiPort: options.agentWebuiPort }),
      clock,
      cluster: "default",
      eventBus,
      namespace: "agent-runtime",
      proxy,
      runtimeImage: "archai/agent-webui:m1",
      runtimePort: 4096,
      store,
      templatesRoot: "./resources/templates",
      ttlSeconds: 3600,
      userWorkspaceInitializer,
      workload,
      workdirRoot: "/nas/agent-master/users",
    },
  });
  return { app, clock, eventBus, proxy, store };
}

async function ensureRuntime(app: ReturnType<typeof buildRuntimeApp>["app"]): Promise<void> {
  const response = await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });
  if (response.statusCode !== 201 && response.statusCode !== 200) {
    throw new Error(`failed to ensure runtime: ${response.statusCode}`);
  }
}

describe("agent-webui HTTP proxy", () => {
  test("does not register /webui/* when agentWebuiPort is not configured", async () => {
    const { app } = buildRuntimeApp();
    await ensureRuntime(app);

    const response = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/webui/" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  test("rejects /webui/* without x-user-id", async () => {
    const { app } = buildRuntimeApp({ agentWebuiPort: 3000 });

    const response = await app.inject({ method: "GET", url: "/webui/" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "MISSING_USER_ID" });
    await app.close();
  });

  test("forwards /webui/* to agent-webui service port while preserving /webui upstream prefix", async () => {
    const { app, proxy } = buildRuntimeApp({ agentWebuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui/adapter-info?verbose=true",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      method: "GET",
      path: "/webui/adapter-info",
      query: { verbose: "true" },
      servicePort: 3000,
    });
    await app.close();
  });

  test("maps /webui root to upstream /webui/ for OpenSumi bundle", async () => {
    const { app, proxy } = buildRuntimeApp({ agentWebuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/webui/" });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({ path: "/webui/", servicePort: 3000 });
    await app.close();
  });

  test("does not forward authorization, x-user-id, host or hop-by-hop headers to agent-webui", async () => {
    const { app, proxy } = buildRuntimeApp({ agentWebuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({
      headers: {
        authorization: "Bearer secret",
        connection: "keep-alive",
        cookie: "agent_webui_sid=abc",
        host: "public.example.test",
        "proxy-authorization": "Basic upstream",
        te: "trailers",
        upgrade: "websocket",
        "x-user-id": "user-a",
      },
      method: "GET",
      url: "/webui/adapter-info",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]?.headers).not.toHaveProperty("authorization");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("connection");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("host");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("proxy-authorization");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("te");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("upgrade");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("x-user-id");
    expect(proxy.requests[0]?.headers).toMatchObject({ cookie: "agent_webui_sid=abc" });
    await app.close();
  });

  test("renews runtime lease periodically for long-lived agent-webui SSE streams", async () => {
    const { app, clock, eventBus, proxy, store } = buildRuntimeApp({ agentWebuiPort: 3000 });
    await ensureRuntime(app);
    const received: string[] = [];
    const unsubscribe = eventBus.subscribe("user-a", (event) => {
      received.push(event.type);
    });
    const proxyService = new RuntimeAgentWebuiProxyService({
      agentWebuiPort: 3000,
      clock,
      eventBus,
      proxy,
      store,
      ttlSeconds: 3600,
    });

    const stop = proxyService.startSseLeaseRenewal({ intervalMs: 1, userId: "user-a" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    stop();
    unsubscribe();

    expect(received).toContain("runtime.ttl.extended");
    await app.close();
  });
});
