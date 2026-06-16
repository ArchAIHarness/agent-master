import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";

import { RuntimeAgentProxyService } from "./application/runtime/runtime-agent-proxy-service";
import { RuntimeCommandService } from "./application/runtime/runtime-command-service";
import { RuntimeEventStreamService } from "./application/runtime/runtime-event-stream-service";
import { RuntimeQueryService } from "./application/runtime/runtime-query-service";
import { loadConfig, type SchedulerConfig } from "./config";
import { registerAgentProxyRoutes } from "./interfaces/http/agent-proxy-routes";
import { registerRuntimeRoutes } from "./interfaces/http/runtime-routes";
import type { RuntimeDependenciesOptions } from "./ports/runtime-dependencies";

export interface BuildAppOptions {
  config?: SchedulerConfig;
  runtime?: RuntimeDependenciesOptions;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: { level: config.logLevel } });

  void app.register(sensible);

  app.get("/health", async () => ({
    service: "agent-master",
    status: "ok",
  }));

  if (options.runtime) {
    registerRuntimeModules(app, options.runtime);
  }

  return app;
}

function registerRuntimeModules(app: FastifyInstance, runtimeDependencies: RuntimeDependenciesOptions): void {
  const commandService = new RuntimeCommandService(runtimeDependencies);
  const queryService = new RuntimeQueryService({ store: runtimeDependencies.store });
  const eventStreamService = new RuntimeEventStreamService({
    clock: runtimeDependencies.clock,
    eventBus: runtimeDependencies.eventBus,
    store: runtimeDependencies.store,
    ttlSeconds: runtimeDependencies.ttlSeconds,
  });
  const proxyService = new RuntimeAgentProxyService({
    clock: runtimeDependencies.clock,
    eventBus: runtimeDependencies.eventBus,
    proxy: runtimeDependencies.proxy,
    scenes: runtimeDependencies.scenes,
    store: runtimeDependencies.store,
    ttlSeconds: runtimeDependencies.ttlSeconds,
  });

  void app.register(registerRuntimeRoutes, {
    commandService,
    eventStreamService,
    queryService,
  });
  void app.register(registerAgentProxyRoutes, { proxyService });
}
