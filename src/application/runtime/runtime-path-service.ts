import { MissingUserIdError } from "../../domain/runtime/runtime-errors";

export function requireUserId(value: string | undefined): string {
  const userId = value?.trim();
  if (!userId) {
    throw new MissingUserIdError();
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
