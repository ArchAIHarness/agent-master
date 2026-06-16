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

  test("does not send decoded body with stale encoded body headers", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = {
      body: [{ ok: true }],
      headers: {
        "Content-Encoding": "gzip",
        "Content-Length": "999",
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
      statusCode: 200,
    };

    const response = await app.inject({
      headers: { "accept-encoding": "gzip", "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/agent/session",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).not.toBe("999");
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual([{ ok: true }]);
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

  test("exposes interaction capabilities without leaking internal AgentApp", async () => {
    const { app } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/interactions/capabilities",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      abort: true,
      agents: true,
      attachments: true,
      commands: true,
      files: true,
      messages: true,
      models: true,
      streaming: true,
      terminal: true,
      tools: true,
      usage: false,
    });

    const leakedAgentAppEndpoint = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/interactions/agent-apps",
    });
    expect(leakedAgentAppEndpoint.statusCode).toBe(404);
    await app.close();
  });

  test("normalizes OpenCode messages through interaction BFF", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = {
      body: [
        {
          info: {
            id: "msg-user",
            role: "user",
            sessionID: "ses-1",
            time: { created: 1781506601637 },
          },
          parts: [{ text: "你好", type: "text" }],
        },
        {
          info: {
            finish: "stop",
            id: "msg-assistant",
            parentID: "msg-user",
            role: "assistant",
            sessionID: "ses-1",
          },
          parts: [{ text: "你好，我是 OpenCode。", type: "text" }],
        },
      ],
      headers: { "content-type": "application/json" },
      statusCode: 200,
    };

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/interactions/sessions/ses-1/messages",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      method: "GET",
      path: "/session/ses-1/message",
    });
    expect(JSON.parse(response.body)).toEqual([
      {
        content: [{ text: "你好", type: "text" }],
        createdAt: 1781506601637,
        id: "msg-user",
        role: "user",
        sessionId: "ses-1",
        status: "completed",
      },
      {
        content: [{ text: "你好，我是 OpenCode。", type: "text" }],
        id: "msg-assistant",
        parentId: "msg-user",
        role: "assistant",
        sessionId: "ses-1",
        status: "completed",
      },
    ]);
    await app.close();
  });

  test("sends interaction messages through OpenCode prompt_async", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = { headers: {}, statusCode: 204 };

    const response = await app.inject({
      body: { agent: "build", text: "帮我分析问题" },
      headers: { authorization: "Bearer secret", "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/messages",
    });

    expect(response.statusCode).toBe(202);
    expect(proxy.requests[0]).toMatchObject({
      body: {
        agent: "build",
        parts: [{ text: "帮我分析问题", type: "text" }],
      },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      path: "/session/ses-1/prompt_async",
    });
    expect(JSON.parse(response.body)).toEqual({ sessionId: "ses-1", status: "submitted" });
    await app.close();
  });

  test("aborts interaction session through AgentApp adapter", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = { body: { success: true }, headers: { "content-type": "application/json" }, statusCode: 200 };

    const response = await app.inject({
      body: {},
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/abort",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({ method: "POST", path: "/session/ses-1/abort" });
    expect(JSON.parse(response.body)).toEqual({ sessionId: "ses-1", status: "cancelling" });
    await app.close();
  });

  test("executes terminal command through AgentApp adapter", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = {
      body: { output: "/app/coding" },
      headers: { "content-type": "application/json" },
      statusCode: 200,
    };

    const response = await app.inject({
      body: { command: "pwd" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/terminal",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests[0]).toMatchObject({
      body: { command: "pwd" },
      method: "POST",
      path: "/session/ses-1/shell",
    });
    expect(JSON.parse(response.body)).toEqual({ sessionId: "ses-1", stderr: "", stdout: "/app/coding" });
    await app.close();
  });

  test("rejects unsafe interaction session id before proxying", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/interactions/sessions/..%2Ffile%2Fcontent%3Fpath%3D%2Fapp%2FAGENTS.md%23/messages",
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_SESSION_ID" });
    expect(proxy.requests).toHaveLength(0);
    await app.close();
  });

  test("maps non-2xx AgentApp upstream response without leaking upstream body", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = {
      body: { code: "SESSION_NOT_FOUND", internalPath: "/root/.config/opencode/opencode.jsonc", message: "session missing" },
      headers: { "content-type": "application/json" },
      statusCode: 404,
    };

    const response = await app.inject({
      body: { text: "不会被提交成功" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-missing/messages",
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ code: "INTERACTION_UPSTREAM_ERROR", message: "Interaction upstream request failed", upstreamStatusCode: 404 });
    expect(response.body).not.toContain("/root/.config/opencode");
    await app.close();
  });

  test("enters interaction session with details, messages, status and default model", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.enqueueResponse({
      body: { id: "ses-1", title: "工作会话", directory: "/app/coding", time: { created: 1781506601000, updated: 1781506602000 } },
      headers: { "content-type": "application/json" },
      statusCode: 200,
    });
    proxy.enqueueResponse({
      body: [
        { info: { id: "msg-user", role: "user", sessionID: "ses-1", time: { created: 1781506603000 } }, parts: [{ type: "text", text: "你好" }] },
        { info: { finish: "stop", id: "msg-assistant", parentID: "msg-user", role: "assistant", sessionID: "ses-1" }, parts: [{ type: "text", text: "你好" }] },
      ],
      headers: { "content-type": "application/json" },
      statusCode: 200,
    });

    const response = await app.inject({
      headers: { "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/interactions/sessions/ses-1",
    });

    expect(response.statusCode).toBe(200);
    expect(proxy.requests.map((request) => request.path)).toEqual(["/session/ses-1", "/session/ses-1/message"]);
    expect(JSON.parse(response.body)).toMatchObject({
      capabilities: { messages: true, streaming: true, terminal: true },
      messages: [
        { id: "msg-user", role: "user", sessionId: "ses-1", status: "completed" },
        { id: "msg-assistant", role: "assistant", sessionId: "ses-1", status: "completed" },
      ],
      session: {
        directory: "/app/coding",
        id: "ses-1",
        model: { mode: "default" },
        status: "idle",
        title: "工作会话",
      },
    });
    await app.close();
  });

  test("lists sessions and agents through interaction BFF", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.enqueueResponse({
      body: [{ id: "ses-1", title: "会话 1", directory: "/app/coding" }],
      headers: { "content-type": "application/json" },
      statusCode: 200,
    });
    proxy.enqueueResponse({
      body: [{ name: "build", mode: "primary" }],
      headers: { "content-type": "application/json" },
      statusCode: 200,
    });

    const sessionsResponse = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/sessions" });
    const agentsResponse = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/agents" });

    expect(sessionsResponse.statusCode).toBe(200);
    expect(agentsResponse.statusCode).toBe(200);
    expect(proxy.requests.map((request) => request.path)).toEqual(["/session", "/agent"]);
    expect(JSON.parse(sessionsResponse.body)).toEqual([{ directory: "/app/coding", id: "ses-1", model: { mode: "default" }, status: "idle", title: "会话 1" }]);
    expect(JSON.parse(agentsResponse.body)).toEqual([{ mode: "primary", name: "build" }]);
    await app.close();
  });

  test("supports session model settings and per-message model override", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = { headers: {}, statusCode: 204 };

    const modelsResponse = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/models" });
    const setModelResponse = await app.inject({
      body: { model: "claude-sonnet-4", provider: "anthropic" },
      headers: { "x-user-id": "user-a" },
      method: "PUT",
      url: "/api/v1/runtime/interactions/sessions/ses-1/model",
    });
    const sendWithSessionModel = await app.inject({
      body: { text: "使用会话模型" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/messages",
    });
    const sendWithOverride = await app.inject({
      body: { model: { model: "deepseek-chat", provider: "deepseek" }, text: "使用单次覆盖" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/messages",
    });

    expect(modelsResponse.statusCode).toBe(200);
    expect(JSON.parse(modelsResponse.body)).toMatchObject({ current: { mode: "default" } });
    expect(setModelResponse.statusCode).toBe(200);
    expect(JSON.parse(setModelResponse.body)).toEqual({ model: "claude-sonnet-4", mode: "configured", provider: "anthropic" });
    expect(sendWithSessionModel.statusCode).toBe(202);
    expect(sendWithOverride.statusCode).toBe(202);
    expect(proxy.requests[0]?.body).toMatchObject({ model: { modelID: "claude-sonnet-4", providerID: "anthropic" } });
    expect(proxy.requests[1]?.body).toMatchObject({ model: { modelID: "deepseek-chat", providerID: "deepseek" } });
    await app.close();
  });

  test("does not pass model when no model is configured", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = { headers: {}, statusCode: 204 };

    const response = await app.inject({
      body: { text: "使用默认模型" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/messages",
    });

    expect(response.statusCode).toBe(202);
    expect(proxy.requests[0]?.body).not.toHaveProperty("model");
    await app.close();
  });

  test("isolates interaction session model by user and session", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    await app.inject({ headers: { "x-user-id": "user-b" }, method: "POST", url: "/api/v1/runtime" });
    proxy.response = { headers: {}, statusCode: 204 };

    await app.inject({
      body: { model: "claude-sonnet-4", provider: "anthropic" },
      headers: { "x-user-id": "user-a" },
      method: "PUT",
      url: "/api/v1/runtime/interactions/sessions/ses-shared/model",
    });
    const userBResponse = await app.inject({
      body: { text: "user-b should use default model" },
      headers: { "x-user-id": "user-b" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-shared/messages",
    });

    expect(userBResponse.statusCode).toBe(202);
    expect(proxy.requests[0]?.body).not.toHaveProperty("model");
    await app.close();
  });

  test("uploads attachments by writing files into runtime workspace before sending references", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.enqueueResponse({ body: { exitCode: 0, stderr: "", stdout: "" }, headers: { "content-type": "application/json" }, statusCode: 200 });
    proxy.enqueueResponse({ headers: {}, statusCode: 204 });

    const uploadResponse = await app.inject({
      body: { content: "# API", mimeType: "text/markdown", name: "API.md" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/attachments",
    });
    const attachment = JSON.parse(uploadResponse.body);
    const sendResponse = await app.inject({
      body: { attachments: [{ id: attachment.id }], text: "分析附件" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/messages",
    });

    expect(uploadResponse.statusCode).toBe(201);
    expect(attachment).toMatchObject({ mimeType: "text/markdown", name: "API.md", sessionId: "ses-1", status: "ready" });
    expect(attachment.path).toStartWith("/app/.interaction/uploads/ses-1/");
    expect(attachment.path).not.toContain("..");
    expect(proxy.requests[0]).toMatchObject({ method: "POST", path: "/session/ses-1/shell" });
    expect(JSON.stringify(proxy.requests[0]?.body)).toContain("base64");
    expect(JSON.stringify(proxy.requests[0]?.body)).toContain(attachment.path);
    expect(sendResponse.statusCode).toBe(202);
    const sentBody = proxy.requests[1]?.body as { parts: Array<{ text: string; type: string }> };
    expect(sentBody.parts[0]).toMatchObject({ type: "text" });
    expect(sentBody.parts[0]?.text).toContain("分析附件");
    expect(sentBody.parts[0]?.text).toContain(attachment.path);
    await app.close();
  });

  test("does not mark attachment ready when runtime write result cannot be verified", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.enqueueResponse({ body: { stderr: "write failed" }, headers: { "content-type": "application/json" }, statusCode: 200 });

    const uploadResponse = await app.inject({
      body: { content: "broken", mimeType: "text/plain", name: "broken.txt" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/attachments",
    });
    const sendResponse = await app.inject({
      body: { attachments: [{ id: "att-000001" }], text: "read it" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-1/messages",
    });

    expect(uploadResponse.statusCode).toBe(502);
    expect(JSON.parse(uploadResponse.body)).toMatchObject({ code: "INTERACTION_ATTACHMENT_WRITE_FAILED" });
    expect(sendResponse.statusCode).toBe(404);
    expect(proxy.requests).toHaveLength(1);
    await app.close();
  });

  test("does not allow another user to reuse attachment id from same session id", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    await app.inject({ headers: { "x-user-id": "user-b" }, method: "POST", url: "/api/v1/runtime" });
    proxy.enqueueResponse({ body: { exitCode: 0, stderr: "", stdout: "" }, headers: { "content-type": "application/json" }, statusCode: 200 });

    const uploadResponse = await app.inject({
      body: { content: "secret", mimeType: "text/plain", name: "secret.txt" },
      headers: { "x-user-id": "user-a" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-shared/attachments",
    });
    const attachment = JSON.parse(uploadResponse.body);
    const sendResponse = await app.inject({
      body: { attachments: [{ id: attachment.id }], text: "read it" },
      headers: { "x-user-id": "user-b" },
      method: "POST",
      url: "/api/v1/runtime/interactions/sessions/ses-shared/messages",
    });

    expect(uploadResponse.statusCode).toBe(201);
    expect(sendResponse.statusCode).toBe(404);
    expect(JSON.parse(sendResponse.body)).toMatchObject({ code: "INTERACTION_ATTACHMENT_NOT_FOUND" });
    expect(proxy.requests).toHaveLength(1);
    await app.close();
  });

  test("rejects interaction file paths outside runtime workspace before proxying", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const sensitiveContent = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/files/content?path=/root/.config/opencode/opencode.jsonc" });
    const traversalList = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/files?path=/app/%2e%2e/.runtime/opencode/share" });
    const nullByteContent = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/files/content?path=/app/coding/AGENTS.md%00.md" });

    expect(sensitiveContent.statusCode).toBe(400);
    expect(traversalList.statusCode).toBe(400);
    expect(nullByteContent.statusCode).toBe(400);
    expect(JSON.parse(sensitiveContent.body)).toMatchObject({ code: "INVALID_INTERACTION_FILE_PATH" });
    expect(proxy.requests).toHaveLength(0);
    await app.close();
  });

  test("executes slash command and file operations through interaction BFF", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    proxy.enqueueResponse({ body: { success: true }, headers: { "content-type": "application/json" }, statusCode: 200 });
    proxy.enqueueResponse({
      body: [
        { absolute: "/app/.runtime", name: ".runtime", path: ".runtime/", type: "directory" },
        { absolute: "/app/coding/AGENTS.md", name: "AGENTS.md", path: "AGENTS.md", type: "file" },
      ],
      headers: { "content-type": "application/json" },
      statusCode: 200,
    });
    proxy.enqueueResponse({ body: { content: "# AGENTS", type: "text" }, headers: { "content-type": "application/json" }, statusCode: 200 });
    proxy.enqueueResponse({ body: [{ file: "README.md", status: "modified" }], headers: { "content-type": "application/json" }, statusCode: 200 });

    const commandResponse = await app.inject({ body: { arguments: "", command: "review" }, headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime/interactions/sessions/ses-1/commands" });
    const filesResponse = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/files?path=/app/coding" });
    const contentResponse = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/files/content?path=/app/coding/AGENTS.md" });
    const statusResponse = await app.inject({ headers: { "x-user-id": "user-a" }, method: "GET", url: "/api/v1/runtime/interactions/files/status" });

    expect(commandResponse.statusCode).toBe(200);
    expect(filesResponse.statusCode).toBe(200);
    expect(contentResponse.statusCode).toBe(200);
    expect(statusResponse.statusCode).toBe(200);
    expect(JSON.parse(filesResponse.body)).toEqual([
      { absolute: "/app/coding/AGENTS.md", name: "AGENTS.md", path: "AGENTS.md", type: "file" },
    ]);
    expect(proxy.requests.map((request) => request.path)).toEqual([
      "/session/ses-1/command",
      "/file",
      "/file/content",
      "/file/status",
    ]);
    await app.close();
  });

  test("rejects unsafe interaction event directory before proxying", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });

    const response = await app.inject({
      headers: { "x-sse-test-once": "true", "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/interactions/sessions/ses-1/events?directory=/app/.runtime/opencode/share",
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_INTERACTION_FILE_PATH" });
    expect(proxy.requests).toHaveLength(0);
    await app.close();
  });

  test("normalizes interaction session event stream", async () => {
    const { app, proxy } = buildRuntimeApp();
    await app.inject({ headers: { "x-user-id": "user-a" }, method: "POST", url: "/api/v1/runtime" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: server.connected\ndata: {\"type\":\"server.connected\"}\n\n"));
        controller.enqueue(new TextEncoder().encode("event: session.updated\ndata: {\"sessionID\":\"ses-1\"}\n\n"));
        controller.close();
      },
    });
    proxy.response = { headers: { "content-type": "text/event-stream" }, isEventStream: true, statusCode: 200, stream };

    const response = await app.inject({
      headers: { "x-sse-test-once": "true", "x-user-id": "user-a" },
      method: "GET",
      url: "/api/v1/runtime/interactions/sessions/ses-1/events?directory=/app/coding",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: session.connected");
    expect(response.body).toContain("event: assistant.snapshot");
    expect(proxy.requests[0]).toMatchObject({ path: "/event", query: { directory: "/app/coding" } });
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
