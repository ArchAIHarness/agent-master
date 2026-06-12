import { buildApp } from "./app";
import { loadConfig } from "./config";
import { buildProductionRuntimeDependenciesFromFile } from "./infrastructure/production-runtime-dependencies";

const config = loadConfig();
const runtime = await buildProductionRuntimeDependenciesFromFile();
const app = buildApp({ config, runtime });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ error }, "failed to start agent-control");
  process.exit(1);
}
