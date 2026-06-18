import sensible from "@fastify/sensible";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import { RuntimeAgentProxyService } from "./application/runtime/runtime-agent-proxy-service";
import { RuntimeAgentWebuiProxyService } from "./application/runtime/runtime-agent-webui-proxy-service";
import { RuntimeAgentWebSocketService } from "./application/runtime/runtime-agent-websocket-service";
import { RuntimeCommandService } from "./application/runtime/runtime-command-service";
import { RuntimeEventStreamService } from "./application/runtime/runtime-event-stream-service";
import { RuntimeQueryService } from "./application/runtime/runtime-query-service";
import { loadConfig, type SchedulerConfig } from "./config";
import { registerAgentProxyRoutes } from "./interfaces/http/agent-proxy-routes";
import { registerAgentWebuiProxyRoutes } from "./interfaces/http/agent-webui-proxy-routes";
import { registerAgentWebSocketRoutes } from "./interfaces/http/agent-websocket-routes";
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
  void app.register(websocket);

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
    store: runtimeDependencies.store,
    ttlSeconds: runtimeDependencies.ttlSeconds,
  });

  void app.register(registerRuntimeRoutes, {
    commandService,
    eventStreamService,
    queryService,
  });
  void app.register(registerAgentProxyRoutes, { proxyService });

  if (runtimeDependencies.agentWebuiPort !== undefined) {
    const agentWebuiProxyService = new RuntimeAgentWebuiProxyService({
      agentWebuiPort: runtimeDependencies.agentWebuiPort,
      clock: runtimeDependencies.clock,
      eventBus: runtimeDependencies.eventBus,
      proxy: runtimeDependencies.proxy,
      store: runtimeDependencies.store,
      ttlSeconds: runtimeDependencies.ttlSeconds,
    });
    void app.register(registerAgentWebuiProxyRoutes, {
      pathPrefix: runtimeDependencies.agentWebuiPathPrefix ?? "/webui",
      proxyService: agentWebuiProxyService,
    });
  }

  if (runtimeDependencies.websocket) {
    const websocketService = new RuntimeAgentWebSocketService({
      clock: runtimeDependencies.clock,
      eventBus: runtimeDependencies.eventBus,
      store: runtimeDependencies.store,
      ttlSeconds: runtimeDependencies.ttlSeconds,
      websocket: runtimeDependencies.websocket,
    });
    void app.register(registerAgentWebSocketRoutes, { websocketService });
  }
}
