import type { InteractionMessage, InteractionRole } from "../interaction-dtos";

interface OpenCodeMessage {
  readonly info?: {
    readonly id?: unknown;
    readonly sessionID?: unknown;
    readonly role?: unknown;
    readonly parentID?: unknown;
    readonly finish?: unknown;
    readonly time?: {
      readonly created?: unknown;
    };
  };
  readonly parts?: readonly OpenCodeMessagePart[];
}

interface OpenCodeMessagePart {
  readonly type?: unknown;
  readonly text?: unknown;
}

export function mapOpenCodeMessages(value: unknown): InteractionMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(mapOpenCodeMessage).filter((message): message is InteractionMessage => message !== undefined);
}

export function mapOpenCodeMessage(message: unknown): InteractionMessage | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const openCodeMessage = message as OpenCodeMessage;
  const info = openCodeMessage.info;
  if (!info || typeof info.id !== "string" || typeof info.sessionID !== "string" || !isInteractionRole(info.role)) {
    return undefined;
  }

  return {
    content: mapTextParts(openCodeMessage.parts),
    ...(typeof info.time?.created === "number" ? { createdAt: info.time.created } : {}),
    id: info.id,
    ...(typeof info.parentID === "string" ? { parentId: info.parentID } : {}),
    role: info.role,
    sessionId: info.sessionID,
    status: "completed",
  };
}

function mapTextParts(parts: readonly OpenCodeMessagePart[] | undefined) {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => ({ text: part.text as string, type: "text" as const }));
}

function isInteractionRole(value: unknown): value is InteractionRole {
  return value === "user" || value === "assistant" || value === "system" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
