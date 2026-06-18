import { existsSync, readFileSync } from "node:fs";

import type { RuntimeDependenciesOptions } from "../ports/runtime-dependencies";
import { SystemRuntimeClock } from "./fake/fixed-runtime-clock";
import { FileSystemUserWorkspaceInitializer } from "./file-system-user-workspace-initializer";
import { InMemoryRuntimeEventBus } from "./fake/in-memory-runtime-event-bus";
import { KubernetesFetchHttpClient } from "./kubernetes/kubernetes-http-client";
import { KubernetesRestWorkloadAdapter, type KubernetesHttpClient } from "./kubernetes/kubernetes-rest-workload-adapter";
import { RuntimeServiceFetchProxy } from "./proxy/runtime-service-fetch-proxy";
import { RuntimeServiceWebSocketProxy } from "./proxy/runtime-service-websocket-proxy";
import type { ProductionConfig } from "./production-config";
import { loadProductionConfig } from "./production-config";
import { IORedisRuntimeClient } from "./redis/ioredis-runtime-client";
import { RedisRuntimeStore, type RedisKeyValueClient } from "./redis/redis-runtime-store";

export interface BuildProductionRuntimeDependenciesOptions {
  readonly config?: ProductionConfig;
  readonly kubernetesHttpClient?: KubernetesHttpClient;
  readonly redisClient?: RedisKeyValueClient;
}

export function buildProductionRuntimeDependencies(options: BuildProductionRuntimeDependenciesOptions = {}): RuntimeDependenciesOptions {
  const config = options.config ?? loadProductionConfigSyncUnsupported();
  const password = resolveConfiguredPassword(config.redis.password);
  const redisClient =
    options.redisClient ??
    new IORedisRuntimeClient({
      db: config.redis.db,
      host: config.redis.host,
      ...(password ? { password } : {}),
      port: config.redis.port,
    });
  const store = new RedisRuntimeStore({
    client: redisClient,
    db: config.redis.db,
    keyPrefix: config.redis.key,
    ttlSeconds: config.runtime.ttl,
  });
  const kubernetesHttp =
    options.kubernetesHttpClient ??
    new KubernetesFetchHttpClient({
      apiServer: resolveKubernetesApiServer(),
      ...readServiceAccountCredentials(),
    });
  const maxRuntimePerNamespace = resolveMaxRuntimePerNamespace(config);
  const userWorkspaceInitializer = new FileSystemUserWorkspaceInitializer();

  return {
    clock: new SystemRuntimeClock(),
    cluster: config.kubernetes.cluster,
    eventBus: new InMemoryRuntimeEventBus(),
    namespace: config.kubernetes.namespace,
    proxy: new RuntimeServiceFetchProxy({ namespace: config.kubernetes.namespace }),
    runtimeImage: config.runtime.image,
    runtimePort: config.runtime.port,
    store,
    templatesRoot: config.init.templatesRoot,
    ttlSeconds: config.runtime.ttl,
    userWorkspaceInitializer,
    websocket: new RuntimeServiceWebSocketProxy({ namespace: config.kubernetes.namespace }),
    workload: new KubernetesRestWorkloadAdapter({
      http: kubernetesHttp,
      workspacePvcClaimName: config.runtime.workspacePvcClaimName,
      workspacePvcSubPathRoot: config.runtime.workspacePvcSubPathRoot,
      ...(maxRuntimePerNamespace === undefined ? {} : { maxRuntimePerNamespace }),
    }),
    workdirRoot: config.runtime.workdir,
  };
}

export async function buildProductionRuntimeDependenciesFromFile(path = "config.yaml"): Promise<RuntimeDependenciesOptions> {
  const config = await loadProductionConfig(path);
  return buildProductionRuntimeDependencies({ config });
}

function resolveMaxRuntimePerNamespace(config: ProductionConfig): number | undefined {
  const matched = config.kubernetes.clusters.find(
    (cluster) => cluster.name === config.kubernetes.cluster && cluster.namespace === config.kubernetes.namespace,
  );
  return matched?.scheduling.enabled ? matched.scheduling.maxRuntime : undefined;
}

function resolveConfiguredPassword(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const envMatch = /^\$\{(?<name>[A-Z0-9_]+)\}$/.exec(value);
  if (envMatch?.groups?.name) {
    return Bun.env[envMatch.groups.name];
  }
  return value;
}

function resolveKubernetesApiServer(): string {
  return Bun.env.KUBERNETES_SERVICE_HOST && Bun.env.KUBERNETES_SERVICE_PORT
    ? `https://${Bun.env.KUBERNETES_SERVICE_HOST}:${Bun.env.KUBERNETES_SERVICE_PORT}`
    : "https://kubernetes.default.svc";
}

function readServiceAccountCredentials(): { token?: string; caCert?: string } {
  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  return {
    ...(existsSync(tokenPath) ? { token: readFileSync(tokenPath, "utf8").trim() } : {}),
    ...(existsSync(caPath) ? { caCert: readFileSync(caPath, "utf8") } : {}),
  };
}

function loadProductionConfigSyncUnsupported(): ProductionConfig {
  throw new Error("production config must be provided explicitly or loaded with buildProductionRuntimeDependenciesFromFile()");
}
