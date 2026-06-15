import type { RuntimeAgentProxyService } from "../runtime/runtime-agent-proxy-service";
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
  InteractionSession,
  SendInteractionMessageInput,
  SendInteractionMessageResult,
  TerminalResult,
} from "./interaction-dtos";

export interface AgentAppContext {
  readonly proxyService: RuntimeAgentProxyService;
}

export interface ListMessagesInput {
  readonly userId: string;
  readonly sessionId: string;
}

export interface GetSessionInput {
  readonly userId: string;
  readonly sessionId: string;
}

export interface AgentAppAdapter {
  readonly name: string;
  readonly displayName: string;

  getCapabilities(): AgentAppCapabilities;
  describe(input: { default: boolean }): AgentAppDescriptor;
  listSessions(input: { userId: string }): Promise<InteractionSession[]>;
  getSession(input: GetSessionInput): Promise<InteractionSession>;
  listMessages(input: ListMessagesInput): Promise<InteractionMessage[]>;
  getMessage(input: { userId: string; sessionId: string; messageId: string }): Promise<InteractionMessage>;
  sendMessage(input: SendInteractionMessageInput): Promise<SendInteractionMessageResult>;
  abort(input: AbortInteractionSessionInput): Promise<AbortInteractionSessionResult>;
  executeCommand(input: ExecuteCommandInput): Promise<CommandResult>;
  executeTerminal(input: ExecuteTerminalInput): Promise<TerminalResult>;
  listAgents(input: { userId: string }): Promise<InteractionAgent[]>;
  listFiles(input: { userId: string; path: string }): Promise<InteractionFileEntry[]>;
  getFileContent(input: { userId: string; path: string }): Promise<InteractionFileContent>;
  getFileStatus(input: { userId: string }): Promise<InteractionFileStatus[]>;
  streamEvents(input: { userId: string; sessionId: string; directory?: string }): Promise<ReadableStream<Uint8Array>>;
}

export type AgentAppAdapterConstructor = new (context: AgentAppContext) => AgentAppAdapter;
