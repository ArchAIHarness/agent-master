import type { FastifyInstance, FastifyReply } from "fastify";

import { AgentAppUpstreamError, assertSafeInteractionSessionId, InteractionAttachmentNotFoundError, InteractionAttachmentWriteError, InvalidInteractionFilePathError, InvalidInteractionSessionIdError } from "../../application/interaction/interaction-errors";
import type { InteractionService } from "../../application/interaction/interaction-service";
import { UnknownAgentAppError } from "../../application/interaction/agent-app-registry";
import { requireUserId } from "../../application/runtime/runtime-path-service";
import { mapErrorToStatus } from "./http-errors";

export interface InteractionRoutesDependencies {
  readonly interactionService: InteractionService;
}

export async function registerInteractionRoutes(app: FastifyInstance, dependencies: InteractionRoutesDependencies): Promise<void> {
  app.get("/api/v1/runtime/interactions/capabilities", async (request, reply) => withErrorMapping(reply, () => {
    requireUserId(request.headers["x-user-id"] as string | undefined);
    return reply.code(200).send(dependencies.interactionService.getCapabilities());
  }));

  app.get("/api/v1/runtime/interactions/models", async (request, reply) => withErrorMapping(reply, () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const query = request.query as { sessionID?: string; sessionId?: string };
    const sessionId = query.sessionId ?? query.sessionID;
    return reply.code(200).send(dependencies.interactionService.getModels({ ...(typeof sessionId === "string" ? { sessionId, userId } : {}) }));
  }));

  app.get("/api/v1/runtime/interactions/sessions", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    return reply.code(200).send(await dependencies.interactionService.listSessions({ userId }));
  }));

  app.get("/api/v1/runtime/interactions/agents", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    return reply.code(200).send(await dependencies.interactionService.listAgents({ userId }));
  }));

  app.get("/api/v1/runtime/interactions/files", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const query = request.query as { path?: string };
    return reply.code(200).send(await dependencies.interactionService.listFiles({ path: query.path ?? "/app", userId }));
  }));

  app.get("/api/v1/runtime/interactions/files/content", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const query = request.query as { path?: string };
    return reply.code(200).send(await dependencies.interactionService.getFileContent({ path: query.path ?? "", userId }));
  }));

  app.get("/api/v1/runtime/interactions/files/status", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    return reply.code(200).send(await dependencies.interactionService.getFileStatus({ userId }));
  }));

  app.get("/api/v1/runtime/interactions/sessions/:sessionId", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    return reply.code(200).send(await dependencies.interactionService.getSessionView({ sessionId, userId }));
  }));

  app.get("/api/v1/runtime/interactions/sessions/:sessionId/status", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    return reply.code(200).send(await dependencies.interactionService.getSessionStatus({ sessionId, userId }));
  }));

  app.get("/api/v1/runtime/interactions/sessions/:sessionId/messages", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    return reply.code(200).send(await dependencies.interactionService.listMessages({ sessionId, userId }));
  }));

  app.get("/api/v1/runtime/interactions/sessions/:sessionId/messages/:messageId", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const params = request.params as { sessionId: string; messageId: string };
    assertSafeInteractionSessionId(params.sessionId);
    assertSafeInteractionSessionId(params.messageId);
    return reply.code(200).send(await dependencies.interactionService.getMessage({ messageId: params.messageId, sessionId: params.sessionId, userId }));
  }));

  app.post("/api/v1/runtime/interactions/sessions/:sessionId/messages", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    const body = isRecord(request.body) ? request.body : {};
    const text = typeof body.text === "string" ? body.text : "";
    const attachments = Array.isArray(body.attachments) ? body.attachments.filter(isRecord).map((attachment) => ({ id: String(attachment.id ?? "") })) : [];
    if (!text.trim() && attachments.length === 0) {
      return reply.code(400).send({ code: "INVALID_INTERACTION_MESSAGE", message: "text or attachments is required" });
    }
    const model = isRecord(body.model) ? { mode: "configured" as const, model: String(body.model.model ?? ""), provider: String(body.model.provider ?? "") } : undefined;
    return reply.code(202).send(await dependencies.interactionService.sendMessage({
      ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(model ? { model } : {}),
      ...(text ? { text } : {}),
      sessionId,
      userId,
    }));
  }));

  app.put("/api/v1/runtime/interactions/sessions/:sessionId/model", async (request, reply) => withErrorMapping(reply, () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    const body = isRecord(request.body) ? request.body : {};
    return reply.code(200).send(dependencies.interactionService.setSessionModel({ model: String(body.model ?? ""), provider: String(body.provider ?? ""), sessionId, userId }));
  }));

  app.post("/api/v1/runtime/interactions/sessions/:sessionId/attachments", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    const body = isRecord(request.body) ? request.body : {};
    return reply.code(201).send(await dependencies.interactionService.uploadAttachment({
      content: typeof body.content === "string" ? body.content : "",
      mimeType: typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream",
      name: typeof body.name === "string" ? body.name : "attachment",
      sessionId,
      userId,
    }));
  }));

  app.post("/api/v1/runtime/interactions/sessions/:sessionId/abort", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    return reply.code(200).send(await dependencies.interactionService.abort({ sessionId, userId }));
  }));

  app.post("/api/v1/runtime/interactions/sessions/:sessionId/commands", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    const body = isRecord(request.body) ? request.body : {};
    const command = typeof body.command === "string" ? body.command : "";
    if (!command.trim()) {
      return reply.code(400).send({ code: "INVALID_INTERACTION_COMMAND", message: "command is required" });
    }
    return reply.code(200).send(await dependencies.interactionService.executeCommand({ arguments: typeof body.arguments === "string" ? body.arguments : "", command, sessionId, userId }));
  }));

  app.post("/api/v1/runtime/interactions/sessions/:sessionId/terminal", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    const body = isRecord(request.body) ? request.body : {};
    const command = typeof body.command === "string" ? body.command : "";
    if (!command.trim()) {
      return reply.code(400).send({ code: "INVALID_TERMINAL_COMMAND", message: "command is required" });
    }
    return reply.code(200).send(await dependencies.interactionService.executeTerminal({ command, sessionId, userId }));
  }));

  app.get("/api/v1/runtime/interactions/sessions/:sessionId/events", async (request, reply) => withErrorMapping(reply, async () => {
    const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
    const sessionId = getSafeSessionId(request.params);
    const query = request.query as { directory?: string };
    const stream = await dependencies.interactionService.streamEvents({ ...(typeof query.directory === "string" ? { directory: query.directory } : {}), sessionId, userId });
    reply.header("content-type", "text/event-stream");
    if (request.headers["x-sse-test-once"] === "true") {
      const reader = stream.getReader();
      let body = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        body += new TextDecoder().decode(chunk.value);
      }
      return reply.code(200).send(body);
    }
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    const reader = stream.getReader();
    request.raw.once("close", () => { void reader.cancel(); });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      reply.raw.write(chunk.value);
    }
    reply.raw.end();
    return reply;
  }));
}

function getSafeSessionId(params: unknown): string {
  const sessionId = (params as { sessionId: string }).sessionId;
  assertSafeInteractionSessionId(sessionId);
  return sessionId;
}

async function withErrorMapping(reply: FastifyReply, handler: () => unknown | Promise<unknown>) {
  try {
    return await handler();
  } catch (error) {
    return sendMappedError(reply, error);
  }
}

function sendMappedError(reply: FastifyReply, error: unknown) {
  if (error instanceof InvalidInteractionSessionIdError) {
    return reply.code(400).send({ code: "INVALID_SESSION_ID", message: error.message });
  }
  if (error instanceof InvalidInteractionFilePathError) {
    return reply.code(400).send({ code: "INVALID_INTERACTION_FILE_PATH", message: error.message });
  }
  if (error instanceof InteractionAttachmentNotFoundError) {
    return reply.code(404).send({ code: "INTERACTION_ATTACHMENT_NOT_FOUND", message: error.message });
  }
  if (error instanceof InteractionAttachmentWriteError) {
    return reply.code(502).send({ code: "INTERACTION_ATTACHMENT_WRITE_FAILED", message: error.message });
  }
  if (error instanceof UnknownAgentAppError) {
    return reply.code(503).send({ code: "INTERACTION_SERVICE_UNAVAILABLE", message: "Interaction service is unavailable" });
  }
  if (error instanceof AgentAppUpstreamError) {
    const statusCode = error.upstreamStatusCode >= 500 ? 502 : error.upstreamStatusCode;
    return reply.code(statusCode).send({ code: "INTERACTION_UPSTREAM_ERROR", message: "Interaction upstream request failed", upstreamStatusCode: error.upstreamStatusCode });
  }
  const mapped = mapErrorToStatus(error);
  return reply.code(mapped.statusCode).send(mapped.body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
