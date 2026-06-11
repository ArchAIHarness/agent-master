import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const clusterSchema = z.object({
  name: z.string().min(1),
  apiServer: z.string().url(),
  namespace: z.string().min(1).default("default"),
});

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(3000),
  host: z.string().min(1).default("0.0.0.0"),
  logLevel: logLevelSchema.default("info"),
  clusters: z.array(clusterSchema).default([]),
});

export type SchedulerConfig = z.infer<typeof configSchema>;
export type KubernetesClusterConfig = SchedulerConfig["clusters"][number];

export type Environment = Record<string, string | undefined>;

export function loadConfig(env: Environment = Bun.env): SchedulerConfig {
  return configSchema.parse({
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    clusters: parseClusters(env.K8S_CLUSTERS),
  });
}

function parseClusters(value: string | undefined): unknown {
  if (!value || value.trim().length === 0) {
    return [];
  }

  return JSON.parse(value);
}
