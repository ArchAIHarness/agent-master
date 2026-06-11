import { buildApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = buildApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ error }, "failed to start agent-control");
  process.exit(1);
}
