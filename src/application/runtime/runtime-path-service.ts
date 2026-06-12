import { InvalidUserIdError, MissingUserIdError } from "../../domain/runtime/runtime-errors";

const safeUserIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function requireUserId(value: string | undefined): string {
  const userId = value?.trim();
  if (!userId) {
    throw new MissingUserIdError();
  }
  if (!safeUserIdPattern.test(userId) || userId === "." || userId === ".." || userId.includes("..")) {
    throw new InvalidUserIdError();
  }
  return userId;
}

export function stripAuthorizationHeader(headers: Record<string, string | undefined>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (key.toLowerCase() === "authorization") {
      continue;
    }
    sanitized[key.toLowerCase()] = value;
  }
  return sanitized;
}
