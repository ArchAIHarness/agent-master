import { loadProductionConfig } from "./infrastructure/production-config";
import { buildProductionRuntimeDependencies } from "./infrastructure/production-runtime-dependencies";
import { buildApp } from "./app";

const config = await loadProductionConfig();
const runtime = buildProductionRuntimeDependencies({ config });

const { server } = buildApp(runtime, config);

const port = config.server.port;
const host = config.server.host;
server.listen(port, host, () => {
  console.log(`Server listening at http://${host}:${port}`);
});
