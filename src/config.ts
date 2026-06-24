import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(3000),
  host: z.string().min(1).default("0.0.0.0"),
  logLevel: logLevelSchema.default("info"),
});

export type SchedulerConfig = z.infer<typeof configSchema>;

export type Environment = Record<string, string | undefined>;

export function loadConfig(env: Environment = Bun.env): SchedulerConfig {
  return configSchema.parse({
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
  });
}
