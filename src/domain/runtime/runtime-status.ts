export const runtimeStatuses = [
  "pending",
  "preparing",
  "running",
  "terminating",
  "terminated",
  "failed",
] as const;

export type RuntimeStatus = (typeof runtimeStatuses)[number];
