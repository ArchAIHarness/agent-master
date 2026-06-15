export type InteractionRole = "user" | "assistant" | "system" | "tool";
export type InteractionMessageStatus = "pending" | "streaming" | "completed" | "failed" | "cancelled";
export type InteractionSessionStatus = "idle" | "running" | "cancelling" | "cancelled" | "failed";

export interface AgentAppCapabilities {
  readonly abort: boolean;
  readonly agents: boolean;
  readonly attachments: boolean;
  readonly commands: boolean;
  readonly files: boolean;
  readonly messages: boolean;
  readonly models: boolean;
  readonly streaming: boolean;
  readonly terminal: boolean;
  readonly tools: boolean;
  readonly usage: boolean;
}

export interface AgentAppDescriptor {
  readonly name: string;
  readonly displayName: string;
  readonly default: boolean;
  readonly capabilities: AgentAppCapabilities;
}

export interface InteractionModelSelection {
  readonly mode: "default" | "configured";
  readonly provider?: string;
  readonly model?: string;
}

export interface InteractionModelOption {
  readonly id: string;
  readonly displayName: string;
}

export interface InteractionModelProvider {
  readonly provider: string;
  readonly displayName: string;
  readonly models: InteractionModelOption[];
}

export interface InteractionModelsView {
  readonly current: InteractionModelSelection;
  readonly available: InteractionModelProvider[];
}

export interface InteractionTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface InteractionAttachmentContent {
  readonly type: "attachment";
  readonly attachment: InteractionAttachment;
}

export type InteractionContent = InteractionTextContent | InteractionAttachmentContent;

export interface InteractionAttachment {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly path: string;
  readonly status: "ready";
}

export interface InteractionMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: InteractionRole;
  readonly content: InteractionContent[];
  readonly status: InteractionMessageStatus;
  readonly parentId?: string;
  readonly createdAt?: number;
}

export interface InteractionSession {
  readonly id: string;
  readonly title?: string;
  readonly directory?: string;
  readonly status: InteractionSessionStatus;
  readonly model: InteractionModelSelection;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface InteractionSessionView {
  readonly capabilities: AgentAppCapabilities;
  readonly session: InteractionSession;
  readonly messages: InteractionMessage[];
}

export interface SendInteractionMessageInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly text?: string;
  readonly agent?: string;
  readonly attachments?: Array<{ readonly id: string }>;
  readonly model?: InteractionModelSelection;
}

export interface SendInteractionMessageResult {
  readonly sessionId: string;
  readonly status: "submitted";
}

export interface AbortInteractionSessionInput {
  readonly userId: string;
  readonly sessionId: string;
}

export interface AbortInteractionSessionResult {
  readonly sessionId: string;
  readonly status: "cancelling";
}

export interface ExecuteTerminalInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly command: string;
}

export interface ExecuteCommandInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly command: string;
  readonly arguments?: string;
}

export interface TerminalResult {
  readonly sessionId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
}

export interface CommandResult {
  readonly sessionId: string;
  readonly success: boolean;
}

export interface InteractionAgent {
  readonly name: string;
  readonly mode?: string;
  readonly description?: string;
}

export interface InteractionFileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: string;
}

export interface InteractionFileContent {
  readonly type: string;
  readonly content: string;
}

export interface InteractionFileStatus {
  readonly file: string;
  readonly status: string;
}
