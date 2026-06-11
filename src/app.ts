import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type SchedulerConfig } from "./config";

export interface BuildAppOptions {
  config?: SchedulerConfig;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: { level: config.logLevel } });

  void app.register(sensible);

  app.get("/health", async () => ({
    service: "agent-control",
    status: "ok",
  }));

  return app;
}
