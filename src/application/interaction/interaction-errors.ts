export class InvalidInteractionSessionIdError extends Error {
  constructor(readonly sessionId: string) {
    super("Invalid interaction session id");
    this.name = "InvalidInteractionSessionIdError";
  }
}

export class AgentAppUpstreamError extends Error {
  constructor(
    readonly agentApp: string,
    readonly upstreamStatusCode: number,
    readonly upstreamBody: unknown,
  ) {
    super(`Interaction upstream returned ${upstreamStatusCode}`);
    this.name = "AgentAppUpstreamError";
  }
}

export class InteractionAttachmentNotFoundError extends Error {
  constructor(readonly attachmentId: string) {
    super("Interaction attachment not found");
    this.name = "InteractionAttachmentNotFoundError";
  }
}

export class InteractionAttachmentWriteError extends Error {
  constructor(readonly attachmentPath: string) {
    super("Interaction attachment could not be written");
    this.name = "InteractionAttachmentWriteError";
  }
}

export class InvalidInteractionFilePathError extends Error {
  constructor(readonly path: string) {
    super("Invalid interaction file path");
    this.name = "InvalidInteractionFilePathError";
  }
}

export function assertSafeInteractionSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId) || sessionId === "." || sessionId === ".." || sessionId.includes("..")) {
    throw new InvalidInteractionSessionIdError(sessionId);
  }
}
