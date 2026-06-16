export type RuntimeAgentPresetRegistry = Record<string, string>;

export interface RuntimeNamingPolicyInput {
  runtimeId: string;
}

export function buildRuntimeResourceName(input: RuntimeNamingPolicyInput): string {
  return `opencode-${input.runtimeId}`;
}

export function buildRuntimeWorkspaceRoot(workdirRoot: string, userId: string): string {
  return `${trimTrailingSlash(workdirRoot)}/${userId}`;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
