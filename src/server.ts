import { buildApp } from "./app";
import { loadConfig } from "./config";
import { loadProductionConfig } from "./infrastructure/production-config";
import { buildProductionRuntimeDependencies } from "./infrastructure/production-runtime-dependencies";
import { createProxyDispatcher } from "./interfaces/http/proxy-dispatcher";

const schedulerConfig = loadConfig();
const productionConfig = await loadProductionConfig();
const runtime = buildProductionRuntimeDependencies({ config: productionConfig });
const app = buildApp({ config: schedulerConfig, runtime });

// Fastify 启动后安装代理分发器（此时所有插件已就绪）
await app.listen({ host: schedulerConfig.host, port: schedulerConfig.port });

const proxyDispatcher = createProxyDispatcher(runtime.store, {
  namespace: productionConfig.kubernetes.namespace,
  subdomainPort: productionConfig.proxy.subdomainPort,
  agentPathPort: productionConfig.proxy.agentPathPort,
});
proxyDispatcher.install(app.server);
