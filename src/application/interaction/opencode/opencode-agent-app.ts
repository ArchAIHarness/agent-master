import { agentApp } from "../agent-app-decorator";
import { AgentAppUpstreamError } from "../interaction-errors";
import type { AgentAppAdapter, AgentAppContext, GetSessionInput, ListMessagesInput } from "../agent-app-port";
import type {
  AbortInteractionSessionInput,
  AbortInteractionSessionResult,
  AgentAppCapabilities,
  AgentAppDescriptor,
  CommandResult,
  ExecuteCommandInput,
  ExecuteTerminalInput,
  InteractionAgent,
  InteractionFileContent,
  InteractionFileEntry,
  InteractionFileStatus,
  InteractionMessage,
  InteractionModelSelection,
  InteractionSession,
  SendInteractionMessageInput,
  SendInteractionMessageResult,
  TerminalResult,
} from "../interaction-dtos";
import { mapOpenCodeMessage, mapOpenCodeMessages } from "./opencode-message-mapper";

@agentApp("opencode")
export class OpenCodeAgentApp implements AgentAppAdapter {
  readonly name = "opencode";
  readonly displayName = "OpenCode";

  constructor(private readonly context: AgentAppContext) {}

  getCapabilities(): AgentAppCapabilities {
    return {
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
    };
  }

  describe(input: { default: boolean }): AgentAppDescriptor {
    return {
      capabilities: this.getCapabilities(),
      default: input.default,
      displayName: this.displayName,
      name: this.name,
    };
  }

  async listSessions(input: { userId: string }): Promise<InteractionSession[]> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: "/session", query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return Array.isArray(response.body) ? response.body.map((session) => mapOpenCodeSession(session)) : [];
  }

  async getSession(input: GetSessionInput): Promise<InteractionSession> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: `/session/${input.sessionId}`, query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return mapOpenCodeSession(response.body, input.sessionId);
  }

  async listMessages(input: ListMessagesInput): Promise<InteractionMessage[]> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: `/session/${input.sessionId}/message`, query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return mapOpenCodeMessages(response.body);
  }

  async getMessage(input: { userId: string; sessionId: string; messageId: string }): Promise<InteractionMessage> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: `/session/${input.sessionId}/message/${input.messageId}`, query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return mapOpenCodeMessage(response.body) ?? { content: [], id: input.messageId, role: "assistant", sessionId: input.sessionId, status: "completed" };
  }

  async sendMessage(input: SendInteractionMessageInput): Promise<SendInteractionMessageResult> {
    const text = buildPromptText(input.text ?? "", input.attachments?.map((attachment) => attachment.id) ?? []);
    const body: { agent?: string; model?: { providerID: string; modelID: string }; parts: Array<{ type: "text"; text: string }> } = {
      parts: [{ text, type: "text" }],
    };
    if (input.agent) {
      body.agent = input.agent;
    }
    if (input.model?.mode === "configured" && input.model.provider && input.model.model) {
      body.model = { modelID: input.model.model, providerID: input.model.provider };
    }

    const response = await this.context.proxyService.proxy({ body, headers: { "x-user-id": input.userId }, method: "POST", path: `/session/${input.sessionId}/prompt_async`, query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return { sessionId: input.sessionId, status: "submitted" };
  }

  async abort(input: AbortInteractionSessionInput): Promise<AbortInteractionSessionResult> {
    const response = await this.context.proxyService.proxy({ body: {}, headers: { "x-user-id": input.userId }, method: "POST", path: `/session/${input.sessionId}/abort`, query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return { sessionId: input.sessionId, status: "cancelling" };
  }

  async executeCommand(input: ExecuteCommandInput): Promise<CommandResult> {
    const response = await this.context.proxyService.proxy({ body: { arguments: input.arguments ?? "", command: input.command }, headers: { "x-user-id": input.userId }, method: "POST", path: `/session/${input.sessionId}/command`, query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return { sessionId: input.sessionId, success: true };
  }

  async executeTerminal(input: ExecuteTerminalInput): Promise<TerminalResult> {
    const response = await this.context.proxyService.proxy({ body: { command: input.command }, headers: { "x-user-id": input.userId }, method: "POST", path: `/session/${input.sessionId}/shell`, query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    const responseBody = isRecord(response.body) ? response.body : {};
    return {
      ...(typeof responseBody.exitCode === "number" ? { exitCode: responseBody.exitCode } : {}),
      sessionId: input.sessionId,
      stderr: typeof responseBody.stderr === "string" ? responseBody.stderr : "",
      stdout: typeof responseBody.stdout === "string" ? responseBody.stdout : typeof responseBody.output === "string" ? responseBody.output : "",
    };
  }

  async listAgents(input: { userId: string }): Promise<InteractionAgent[]> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: "/agent", query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return Array.isArray(response.body) ? response.body.map(mapAgent).filter((agent): agent is InteractionAgent => agent !== undefined) : [];
  }

  async listFiles(input: { userId: string; path: string }): Promise<InteractionFileEntry[]> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: "/file", query: { path: input.path }, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return Array.isArray(response.body) ? response.body as InteractionFileEntry[] : [];
  }

  async getFileContent(input: { userId: string; path: string }): Promise<InteractionFileContent> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: "/file/content", query: { path: input.path }, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return isRecord(response.body) ? response.body as unknown as InteractionFileContent : { content: "", type: "text" };
  }

  async getFileStatus(input: { userId: string }): Promise<InteractionFileStatus[]> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: "/file/status", query: {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return Array.isArray(response.body) ? response.body as InteractionFileStatus[] : [];
  }

  async streamEvents(input: { userId: string; sessionId: string; directory?: string }): Promise<ReadableStream<Uint8Array>> {
    const response = await this.context.proxyService.proxy({ headers: { "x-user-id": input.userId }, method: "GET", path: "/event", query: input.directory ? { directory: input.directory } : {}, userId: input.userId });
    this.assertUpstreamSuccess(response.statusCode, response.body);
    return response.stream ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  }

  private assertUpstreamSuccess(statusCode: number, body: unknown): void {
    if (statusCode < 200 || statusCode >= 300) {
      throw new AgentAppUpstreamError(this.name, statusCode, body);
    }
  }
}

function mapOpenCodeSession(value: unknown, fallbackId?: string): InteractionSession {
  const record = isRecord(value) ? value : {};
  const id = typeof record.id === "string" ? record.id : fallbackId ?? "";
  const time = isRecord(record.time) ? record.time : {};
  return {
    ...(typeof time.created === "number" ? { createdAt: time.created } : {}),
    ...(typeof record.directory === "string" ? { directory: record.directory } : {}),
    id,
    model: { mode: "default" },
    status: "idle",
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof time.updated === "number" ? { updatedAt: time.updated } : {}),
  };
}

function mapAgent(value: unknown): InteractionAgent | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  return {
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
    name: value.name,
  };
}

function buildPromptText(text: string, attachmentIds: string[]): string {
  if (attachmentIds.length === 0) {
    return text;
  }
  const refs = attachmentIds.map((id) => `- ${id}`).join("\n");
  return `${text}\n\n附件引用：\n${refs}`.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
