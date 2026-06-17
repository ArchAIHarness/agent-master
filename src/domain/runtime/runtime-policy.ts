export interface RuntimeNamingPolicyInput {
  runtimeId: string;
}

export function buildRuntimeResourceName(input: RuntimeNamingPolicyInput): string {
  return `agent-${input.runtimeId}`;
}

export function buildRuntimeWorkspaceRoot(workdirRoot: string, userId: string): string {
  return `${trimTrailingSlash(workdirRoot)}/${userId}`;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
