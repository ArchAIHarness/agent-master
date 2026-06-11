export const runtimeStatuses = [
  "pending",
  "preparing",
  "running",
  "idle",
  "terminating",
  "terminated",
  "failed",
] as const;

export type RuntimeStatus = (typeof runtimeStatuses)[number];
