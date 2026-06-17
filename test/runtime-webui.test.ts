import { describe, expect, test } from "bun:test";

import { buildApp } from "../src/app";
import { FakeRuntimeAgentProxy } from "../src/infrastructure/fake/fake-runtime-agent-proxy";
import { NoopUserWorkspaceInitializer } from "../src/infrastructure/fake/noop-user-workspace-initializer";
import { FakeRuntimeWorkloadAdapter } from "../src/infrastructure/fake/fake-runtime-workload-adapter";
import { FixedRuntimeClock } from "../src/infrastructure/fake/fixed-runtime-clock";
import { InMemoryRuntimeEventBus } from "../src/infrastructure/fake/in-memory-runtime-event-bus";
import { InMemoryRuntimeStore } from "../src/infrastructure/fake/in-memory-runtime-store";

interface BuildOptions {
  readonly webuiPort?: number;
  readonly webuiPathPrefix?: string;
}

function buildRuntimeApp(options: BuildOptions = {}) {
  const eventBus = new InMemoryRuntimeEventBus();
  const store = new InMemoryRuntimeStore();
  const workload = new FakeRuntimeWorkloadAdapter();
  const proxy = new FakeRuntimeAgentProxy();
  const userWorkspaceInitializer = new NoopUserWorkspaceInitializer();
  const app = buildApp({
    config: {
      clusters: [],
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
      runtimeImage: "ghcr.io/archaiharness/agent-image-webui:latest",
      runtimePort: 4096,
      store,
      templatesRoot: "./resources/templates",
      ttlSeconds: 3600,
      userWorkspaceInitializer,
      workload,
      workdirRoot: "/nas/agent-master/users",
      ...(options.webuiPort === undefined ? {} : { webuiPort: options.webuiPort }),
      ...(options.webuiPathPrefix === undefined ? {} : { webuiPathPrefix: options.webuiPathPrefix }),
    },
  });
  return { app, proxy, store };
}

async function ensureRuntime(app: ReturnType<typeof buildRuntimeApp>["app"]): Promise<void> {
  const response = await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/runtime" });
  if (response.statusCode !== 201 && response.statusCode !== 200) {
    throw new Error(`failed to ensure runtime: ${response.statusCode}`);
  }
}

describe("webui proxy routes", () => {
  test("does not register /webui/* when webuiPort is not configured", async () => {
    const { app } = buildRuntimeApp();
    await ensureRuntime(app);

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui/",
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  test("rejects /webui/* without x-user-id", async () => {
    const { app } = buildRuntimeApp({ webuiPort: 3000 });

    const response = await app.inject({
      method: "GET",
      url: "/webui/",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "MISSING_USER_ID" });
    await app.close();
  });

  test("returns 404 when no runtime exists for the user", async () => {
    const { app } = buildRuntimeApp({ webuiPort: 3000 });

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui/",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "RUNTIME_NOT_FOUND" });
    await app.close();
  });

  test("strips /webui prefix and forwards to AionUi service on configured port", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui/api/conversations?limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      method: "GET",
      path: "/api/conversations",
      query: { limit: "10" },
      servicePort: 3000,
    });
    await app.close();
  });

  test("rewrites root request /webui to upstream / and uses AionUi port", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui/",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      path: "/",
      servicePort: 3000,
    });
    await app.close();
  });

  test("does not forward authorization, x-user-id or hop-by-hop headers to AionUi", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({
      headers: {
        authorization: "Bearer secret",
        connection: "keep-alive",
        cookie: "aionui.sid=abc",
        "proxy-authorization": "Basic upstream",
        te: "trailers",
        upgrade: "websocket",
        "x-user-id": "user-a",
      },
      method: "GET",
      url: "/webui/api/conversations",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]?.headers).not.toHaveProperty("authorization");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("connection");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("proxy-authorization");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("te");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("upgrade");
    expect(proxy.requests[0]?.headers).not.toHaveProperty("x-user-id");
    expect(proxy.requests[0]?.headers).toMatchObject({ cookie: "aionui.sid=abc" });
    await app.close();
  });

  test("rewrites Set-Cookie Path attribute to the configured prefix", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);
    proxy.response = {
      body: { ok: true },
      headers: {
        "content-type": "application/json",
        "set-cookie": "aionui.sid=abc; Path=/; HttpOnly",
      },
      statusCode: 200,
    };

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/webui/api/login",
    });

    expect(response.statusCode).toBe(200);
    const cookie = response.headers["set-cookie"];
    const cookieText = Array.isArray(cookie) ? cookie.join(", ") : cookie ?? "";
    expect(cookieText).toContain("Path=/webui");
    expect(cookieText).not.toContain("Path=/;");
    await app.close();
  });

  test("strips hop-by-hop and length headers from AionUi response", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);
    proxy.response = {
      body: { ok: true },
      headers: {
        connection: "keep-alive",
        "content-encoding": "gzip",
        "content-length": "12",
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      statusCode: 200,
    };

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui/api/conversations",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).not.toHaveProperty("connection");
    expect(response.headers).not.toHaveProperty("content-encoding");
    expect(response.headers).not.toHaveProperty("transfer-encoding");
    expect(response.headers).not.toHaveProperty("content-length", "12");
    await app.close();
  });

  test("supports custom path prefix configuration", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000, webuiPathPrefix: "/ui" });
    await ensureRuntime(app);

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/ui/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      path: "/api/health",
      servicePort: 3000,
    });
    await app.close();
  });
});

describe("webui proxy edge cases", () => {
  test("preserves Expires comma when rewriting multiple Set-Cookie headers", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);
    proxy.response = {
      body: { ok: true },
      headers: {
        "content-type": "application/json",
        "set-cookie":
          "aionui.sid=abc; Path=/; HttpOnly, theme=dark; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      },
      statusCode: 200,
    };

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/webui/api/login",
    });

    expect(response.statusCode).toBe(200);
    const cookie = response.headers["set-cookie"];
    const cookieText = Array.isArray(cookie) ? cookie.join(", ") : cookie ?? "";
    expect(cookieText).toContain("aionui.sid=abc; Path=/webui");
    expect(cookieText).toContain("theme=dark; Path=/webui");
    expect(cookieText).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cookieText.match(/Path=\/webui/g)?.length).toBe(2);
  });

  test("streams SSE responses chunk-by-chunk and does not buffer", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);

    const encoder = new TextEncoder();
    proxy.response = {
      headers: {
        "content-type": "text/event-stream",
      },
      isEventStream: true,
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: ping\ndata: 1\n\n"));
          controller.enqueue(encoder.encode("event: ping\ndata: 2\n\n"));
          controller.close();
        },
      }),
    };

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui/api/events",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("data: 1");
    expect(response.body).toContain("data: 2");
  });

  test("forwards POST body to AionUi without modification", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({
      body: { username: "admin", password: "***" },
      headers: { "content-type": "application/json", "x-user-id": "user-a" },
      method: "POST",
      url: "/webui/api/login",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      body: { username: "admin", password: "***" },
      method: "POST",
      path: "/api/login",
      servicePort: 3000,
    });
  });

  test("does not match adjacent prefixes such as /webui-other", async () => {
    const { app, proxy } = buildRuntimeApp({ webuiPort: 3000 });
    await ensureRuntime(app);

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/webui-other/api/foo",
    });

    expect(response.statusCode).toBe(404);
    expect(proxy.requests.length).toBe(0);
  });
});
