import type { AgentAppAdapter, AgentAppContext } from "./agent-app-port";
import { AgentAppRegistry, UnknownAgentAppError } from "./agent-app-registry";
import { InteractionAttachmentNotFoundError, InteractionAttachmentWriteError, InvalidInteractionFilePathError } from "./interaction-errors";
import type {
  AbortInteractionSessionResult,
  AgentAppCapabilities,
  CommandResult,
  InteractionAgent,
  InteractionAttachment,
  InteractionFileContent,
  InteractionFileEntry,
  InteractionFileStatus,
  InteractionMessage,
  InteractionModelProvider,
  InteractionModelsView,
  InteractionModelSelection,
  InteractionSession,
  InteractionSessionView,
  SendInteractionMessageResult,
  TerminalResult,
} from "./interaction-dtos";
import "./opencode/opencode-agent-app";

export class InteractionService {
  private readonly apps: Map<string, AgentAppAdapter>;
  private readonly attachments = new Map<string, InteractionAttachment>();
  private readonly sessionModels = new Map<string, InteractionModelSelection>();
  private readonly defaultAgentApp = "opencode";
  private nextAttachmentSequence = 1;

  constructor(context: AgentAppContext) {
    this.apps = AgentAppRegistry.assemble(context);
  }

  getCapabilities(): AgentAppCapabilities {
    return this.getDefaultAgentApp().getCapabilities();
  }

  getModels(input: { userId?: string; sessionId?: string }): InteractionModelsView {
    return {
      available: defaultModelProviders(),
      current: input.userId && input.sessionId ? this.getSessionModel(input.userId, input.sessionId) : { mode: "default" },
    };
  }

  setSessionModel(input: { userId: string; sessionId: string; provider: string; model: string }): InteractionModelSelection {
    const selection = validateModelSelection({ mode: "configured", model: input.model, provider: input.provider });
    this.sessionModels.set(sessionScopedKey(input.userId, input.sessionId), selection);
    return selection;
  }

  async listSessions(input: { userId: string }): Promise<InteractionSession[]> {
    return this.getDefaultAgentApp().listSessions(input).then((sessions) => sessions.map((session) => ({ ...session, model: this.getSessionModel(input.userId, session.id) })));
  }

  async getSessionView(input: { userId: string; sessionId: string }): Promise<InteractionSessionView> {
    const [session, messages] = await Promise.all([
      this.getDefaultAgentApp().getSession(input),
      this.getDefaultAgentApp().listMessages(input),
    ]);
    return {
      capabilities: this.getCapabilities(),
      messages,
      session: { ...session, model: this.getSessionModel(input.userId, input.sessionId), status: inferSessionStatus(messages) },
    };
  }

  async getSessionStatus(input: { userId: string; sessionId: string }): Promise<{ sessionId: string; status: InteractionSession["status"]; runningMessageId: string | null }> {
    const messages = await this.getDefaultAgentApp().listMessages(input);
    const running = messages.find((message) => message.status === "streaming" || message.status === "pending");
    return { runningMessageId: running?.id ?? null, sessionId: input.sessionId, status: inferSessionStatus(messages) };
  }

  async listMessages(input: { userId: string; sessionId: string }): Promise<InteractionMessage[]> {
    return this.getDefaultAgentApp().listMessages(input);
  }

  async getMessage(input: { userId: string; sessionId: string; messageId: string }): Promise<InteractionMessage> {
    return this.getDefaultAgentApp().getMessage(input);
  }

  async sendMessage(input: { userId: string; sessionId: string; text?: string; agent?: string; attachments?: Array<{ id: string }>; model?: InteractionModelSelection }): Promise<SendInteractionMessageResult> {
    const model = input.model ? validateModelSelection(input.model) : this.getSessionModel(input.userId, input.sessionId);
    const attachmentRefs = input.attachments?.map((attachment) => this.requireAttachment(input.userId, input.sessionId, attachment.id)) ?? [];
    return this.getDefaultAgentApp().sendMessage({
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.text ? { text: appendAttachmentPaths(input.text, attachmentRefs) } : { text: appendAttachmentPaths("", attachmentRefs) }),
      ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs.map((attachment) => ({ id: attachment.path })) } : {}),
      ...(model.mode === "configured" ? { model } : {}),
      sessionId: input.sessionId,
      userId: input.userId,
    });
  }

  async abort(input: { userId: string; sessionId: string }): Promise<AbortInteractionSessionResult> {
    return this.getDefaultAgentApp().abort(input);
  }

  async executeCommand(input: { userId: string; sessionId: string; command: string; arguments?: string }): Promise<CommandResult> {
    return this.getDefaultAgentApp().executeCommand(input);
  }

  async executeTerminal(input: { userId: string; sessionId: string; command: string }): Promise<TerminalResult> {
    return this.getDefaultAgentApp().executeTerminal(input);
  }

  async listAgents(input: { userId: string }): Promise<InteractionAgent[]> {
    return this.getDefaultAgentApp().listAgents(input);
  }

  async listFiles(input: { userId: string; path: string }): Promise<InteractionFileEntry[]> {
    return this.getDefaultAgentApp().listFiles({ ...input, path: assertSafeWorkspacePath(input.path) });
  }

  async getFileContent(input: { userId: string; path: string }): Promise<InteractionFileContent> {
    return this.getDefaultAgentApp().getFileContent({ ...input, path: assertSafeWorkspacePath(input.path) });
  }

  async getFileStatus(input: { userId: string }): Promise<InteractionFileStatus[]> {
    return this.getDefaultAgentApp().getFileStatus(input);
  }

  async uploadAttachment(input: { userId: string; sessionId: string; name: string; mimeType: string; content: string }): Promise<InteractionAttachment> {
    const safeName = sanitizeAttachmentName(input.name);
    const id = `att-${this.nextAttachmentSequence.toString().padStart(6, "0")}`;
    this.nextAttachmentSequence += 1;
    const attachment = {
      id,
      mimeType: input.mimeType,
      name: safeName,
      path: `/app/.interaction/uploads/${input.sessionId}/${id}-${safeName}`,
      sessionId: input.sessionId,
      size: new TextEncoder().encode(input.content).byteLength,
      status: "ready" as const,
    };
    await this.writeAttachmentFile({ content: input.content, path: attachment.path, sessionId: input.sessionId, userId: input.userId });
    this.attachments.set(attachmentScopedKey(input.userId, input.sessionId, id), attachment);
    return attachment;
  }

  async streamEvents(input: { userId: string; sessionId: string; directory?: string }): Promise<ReadableStream<Uint8Array>> {
    const source = await this.getDefaultAgentApp().streamEvents({
      ...input,
      ...(input.directory ? { directory: assertSafeWorkspacePath(input.directory) } : {}),
    });
    return normalizeInteractionEventStream(source, input.sessionId);
  }

  private getSessionModel(userId: string, sessionId: string): InteractionModelSelection {
    return this.sessionModels.get(sessionScopedKey(userId, sessionId)) ?? { mode: "default" };
  }

  private requireAttachment(userId: string, sessionId: string, id: string): InteractionAttachment {
    const attachment = this.attachments.get(attachmentScopedKey(userId, sessionId, id));
    if (!attachment || attachment.sessionId !== sessionId) {
      throw new InteractionAttachmentNotFoundError(id);
    }
    return attachment;
  }

  private async writeAttachmentFile(input: { userId: string; sessionId: string; path: string; content: string }): Promise<void> {
    const encodedContent = bytesToBase64(new TextEncoder().encode(input.content));
    const command = `mkdir -p ${shellQuote(parentPath(input.path))} && printf %s ${shellQuote(encodedContent)} | base64 -d > ${shellQuote(input.path)}`;
    const result = await this.getDefaultAgentApp().executeTerminal({ command, sessionId: input.sessionId, userId: input.userId });
    if (result.exitCode !== 0) {
      throw new InteractionAttachmentWriteError(input.path);
    }
  }

  private getDefaultAgentApp(): AgentAppAdapter {
    const app = this.apps.get(this.defaultAgentApp);
    if (!app) {
      throw new UnknownAgentAppError(this.defaultAgentApp);
    }
    return app;
  }
}

function defaultModelProviders(): InteractionModelProvider[] {
  return [
    { displayName: "系统默认", models: [{ displayName: "使用默认模型", id: "default" }], provider: "default" },
    { displayName: "Anthropic", models: [{ displayName: "Claude Sonnet 4", id: "claude-sonnet-4" }], provider: "anthropic" },
    { displayName: "DeepSeek", models: [{ displayName: "DeepSeek Chat", id: "deepseek-chat" }], provider: "deepseek" },
  ];
}

function validateModelSelection(model: InteractionModelSelection): InteractionModelSelection {
  if (model.mode === "default") {
    return { mode: "default" };
  }
  const providerId = model.provider;
  const modelId = model.model;
  const provider = defaultModelProviders().find((item) => item.provider === providerId);
  if (!providerId || !modelId || !provider || !provider.models.some((item) => item.id === modelId)) {
    throw new Error("Invalid model selection");
  }
  return { mode: "configured", model: modelId, provider: providerId };
}

function inferSessionStatus(messages: InteractionMessage[]): InteractionSession["status"] {
  return messages.some((message) => message.status === "streaming" || message.status === "pending") ? "running" : "idle";
}

function sessionScopedKey(userId: string, sessionId: string): string {
  return `${userId}\u0000${sessionId}`;
}

function attachmentScopedKey(userId: string, sessionId: string, attachmentId: string): string {
  return `${sessionScopedKey(userId, sessionId)}\u0000${attachmentId}`;
}

function sanitizeAttachmentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.\./g, "_").slice(0, 120) || "attachment";
}

function assertSafeWorkspacePath(path: string): string {
  if (!path || path.includes("\u0000") || path.includes("..") || path.includes("//") || !path.startsWith("/app") || (path !== "/app" && !path.startsWith("/app/")) || path.startsWith("/app/.runtime")) {
    throw new InvalidInteractionFilePathError(path);
  }
  return path;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function appendAttachmentPaths(text: string, attachments: InteractionAttachment[]): string {
  if (attachments.length === 0) {
    return text;
  }
  const refs = attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join("\n");
  return `${text}\n\n附件已保存到：\n${refs}\n请读取这些文件后再处理。`.trim();
}

function normalizeInteractionEventStream(source: ReadableStream<Uint8Array>, sessionId: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      controller.enqueue(encodeSse("session.connected", { sessionId }));
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const text = new TextDecoder().decode(chunk.value);
        if (text.includes("session.updated")) {
          controller.enqueue(encodeSse("session.status", { sessionId, status: "running" }));
          controller.enqueue(encodeSse("assistant.snapshot", { sessionId }));
        }
      }
      controller.close();
    },
  });
}

function encodeSse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
