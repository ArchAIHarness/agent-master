import { describe, expect, test } from "bun:test";

import type { RuntimeSnapshot } from "../src/domain/runtime/runtime";
import { KubernetesRestWorkloadAdapter } from "../src/infrastructure/kubernetes/kubernetes-rest-workload-adapter";
import { RuntimeServiceFetchProxy } from "../src/infrastructure/proxy/runtime-service-fetch-proxy";
import { buildProductionRuntimeDependencies } from "../src/infrastructure/production-runtime-dependencies";
import { parseProductionConfig } from "../src/infrastructure/production-config";
import { RedisRuntimeStore, type RedisKeyValueClient } from "../src/infrastructure/redis/redis-runtime-store";

const runtime: RuntimeSnapshot = {
  cluster: "default",
  createdAt: "2026-06-12T00:00:00.000Z",
  deploymentName: "opencode-rt-000001",
  leaseExpireAt: "2026-06-12T01:00:00.000Z",
  namespace: "agent-runtime",
  podSelector: {
    app: "opencode-runtime",
    runtimeId: "rt-000001",
    userId: "user-a",
  },
  runtimeId: "rt-000001",
  serviceName: "opencode-rt-000001",
  servicePort: 4096,
  status: "running",
  targetPort: 4096,
  updatedAt: "2026-06-12T00:00:00.000Z",
  userId: "user-a",
  workspaceRootPath: "/nas/agent-master/users/user-a",
};

describe("production config", () => {
  test("parses Redis db and empty password from config yaml", () => {
    const config = parseProductionConfig(`
server:
  port: 3000
  host: 0.0.0.0
  log: info
redis:
  host: redis
  port: 6379
  db: 2
  key: agent-runtime:user
  password: ""
runtime:
  image: ghcr.io/archaiharness/agent-runtime:latest
  ttl: 3600
  timeout: 60000
  port: 4096
  workdir: /nas/agent-master/users
  agentPresets:
    coding: /nas/agent-master/agent-presets/coding
nas:
  path: /nas/agent-master
kubernetes:
  cluster: default
  namespace: agent-runtime
  clusters:
    - name: default
      namespace: agent-runtime
      auth: inCluster
      scheduling:
        enabled: true
        maxRuntime: 100
`);

    expect(config.redis).toMatchObject({
      db: 2,
      host: "redis",
      key: "agent-runtime:user",
      password: "",
      port: 6379,
    });
    expect(config.runtime.agentPresets).toEqual({ coding: "/nas/agent-master/agent-presets/coding" });
  });
});

describe("RedisRuntimeStore", () => {
  test("saves runtime state using configured key prefix, db and ttl", async () => {
    const client = new RecordingRedisClient();
    const store = new RedisRuntimeStore({ client, db: 2, keyPrefix: "agent-runtime:user", ttlSeconds: 3600 });

    await store.save(runtime);
    const loaded = await store.getByUserId("user-a");
    await store.deleteByUserId("user-a");

    expect(client.selectedDb).toBe(2);
    expect(client.setCalls[0]).toMatchObject({
      key: "agent-runtime:user:user-a",
      ttlSeconds: 3600,
    });
    expect(loaded).toMatchObject({ runtimeId: "rt-000001", userId: "user-a", status: "running" });
    expect(client.deletedKeys).toEqual(["agent-runtime:user:user-a"]);
  });
});

describe("KubernetesRestWorkloadAdapter", () => {
  test("checks namespace, node readiness, quotas, limits, pod distribution and warnings before scheduling", async () => {
    const http = new RecordingKubernetesHttpClient();
    const adapter = new KubernetesRestWorkloadAdapter({ http });

    const capacity = await adapter.checkCapacity({ cluster: "default", namespace: "agent-runtime" });

    expect(capacity.allowed).toBe(true);
    expect(http.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/namespaces/agent-runtime",
      "GET /api/v1/nodes",
      "GET /api/v1/namespaces/agent-runtime/resourcequotas",
      "GET /api/v1/namespaces/agent-runtime/limitranges",
      "GET /api/v1/namespaces/agent-runtime/pods?labelSelector=app%3Dopencode-runtime",
      "GET /apis/apps/v1/namespaces/agent-runtime/deployments?labelSelector=app%3Dopencode-runtime",
      "GET /api/v1/namespaces/agent-runtime/events?fieldSelector=type%3DWarning",
    ]);
  });

  test("rejects capacity when node has memory pressure", async () => {
    const http = new RecordingKubernetesHttpClient({ nodeMemoryPressure: true });
    const adapter = new KubernetesRestWorkloadAdapter({ http });

    const capacity = await adapter.checkCapacity({ cluster: "default", namespace: "agent-runtime" });

    expect(capacity).toMatchObject({ allowed: false, reason: "cluster default has no schedulable node with enough resources" });
  });

  test("rejects capacity when namespace quota has no remaining service capacity", async () => {
    const http = new RecordingKubernetesHttpClient({ quotaServicesHard: "1", quotaServicesUsed: "1" });
    const adapter = new KubernetesRestWorkloadAdapter({ http });

    const capacity = await adapter.checkCapacity({ cluster: "default", namespace: "agent-runtime" });

    expect(capacity).toMatchObject({ allowed: false, reason: "namespace agent-runtime quota services is exhausted" });
  });

  test("rejects capacity when limit range maximum is below runtime memory request", async () => {
    const http = new RecordingKubernetesHttpClient({ limitMaxMemory: "128Mi" });
    const adapter = new KubernetesRestWorkloadAdapter({ http });

    const capacity = await adapter.checkCapacity({ cluster: "default", namespace: "agent-runtime" });

    expect(capacity).toMatchObject({ allowed: false, reason: "namespace agent-runtime LimitRange max memory is below runtime request" });
  });

  test("rejects capacity when namespace runtime distribution reaches maxRuntime", async () => {
    const http = new RecordingKubernetesHttpClient({ runtimeDeploymentCount: 2 });
    const adapter = new KubernetesRestWorkloadAdapter({ http, maxRuntimePerNamespace: 2 });

    const capacity = await adapter.checkCapacity({ cluster: "default", namespace: "agent-runtime" });

    expect(capacity).toMatchObject({ allowed: false, reason: "namespace agent-runtime reached max runtime count 2" });
  });

  test("rejects capacity when runtime deployment has unavailable condition", async () => {
    const http = new RecordingKubernetesHttpClient({ deploymentUnavailable: true });
    const adapter = new KubernetesRestWorkloadAdapter({ http });

    const capacity = await adapter.checkCapacity({ cluster: "default", namespace: "agent-runtime" });

    expect(capacity).toMatchObject({ allowed: false, reason: "namespace agent-runtime has unhealthy runtime deployments" });
  });

  test("rejects capacity when namespace quota has no remaining runtime pod capacity", async () => {
    const http = new RecordingKubernetesHttpClient({ quotaPodsHard: "1", quotaPodsUsed: "1" });
    const adapter = new KubernetesRestWorkloadAdapter({ http });

    const capacity = await adapter.checkCapacity({ cluster: "default", namespace: "agent-runtime" });

    expect(capacity).toMatchObject({ allowed: false, reason: "namespace agent-runtime quota pods is exhausted" });
  });

  test("creates deployment and service manifests through Kubernetes REST API", async () => {
    const http = new RecordingKubernetesHttpClient();
    const adapter = new KubernetesRestWorkloadAdapter({ http });

    await adapter.createDeployment({ agentPresets: { coding: "/nas/agent-presets/coding" }, image: "agent-runtime:local", runtime });
    await adapter.createService({ agentPresets: { coding: "/nas/agent-presets/coding" }, image: "agent-runtime:local", runtime });
    await adapter.waitUntilReady(runtime);
    await adapter.restartDeployment(runtime);
    await adapter.deleteDeployment(runtime);
    await adapter.deleteService(runtime);

    expect(http.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /apis/apps/v1/namespaces/agent-runtime/deployments",
      "POST /api/v1/namespaces/agent-runtime/services",
      "GET /apis/apps/v1/namespaces/agent-runtime/deployments/opencode-rt-000001",
      "PATCH /apis/apps/v1/namespaces/agent-runtime/deployments/opencode-rt-000001",
      "DELETE /apis/apps/v1/namespaces/agent-runtime/deployments/opencode-rt-000001",
      "DELETE /api/v1/namespaces/agent-runtime/services/opencode-rt-000001",
    ]);
    const deployment = http.requests[0]?.body as Record<string, any>;
    const podSpec = deployment.spec.template.spec;
    const initContainer = podSpec.initContainers[0];
    const runtimeContainer = podSpec.containers[0];
    const initCommand = initContainer.command[2] as string;

    expect(deployment).toMatchObject({ kind: "Deployment", spec: { replicas: 1 } });
    expect(http.requests[3]?.contentType).toBe("application/strategic-merge-patch+json");
    expect(initContainer).toMatchObject({ name: "prepare-user-workdir" });
    expect(initCommand).toContain("mkdir -p /app/.runtime/opencode/share");
    expect(initCommand).toContain("mkdir -p /app/.runtime/opencode/config");
    expect(initCommand).toContain("cp '/agent-preset-config/coding/AGENTS.md' '/app/coding/AGENTS.md'");
    expect(initCommand).toContain("cp -R '/agent-preset-config/coding/.opencode/.' '/app/coding/.opencode/'");
    expect(runtimeContainer.command).toEqual(["/bin/sh", "-c"]);
    expect(runtimeContainer.args[0]).toContain("opencode web --port 4096 --hostname 0.0.0.0");
    expect(runtimeContainer.args[0]).toContain("quarantine");
    expect(runtimeContainer.volumeMounts).toEqual(
      expect.arrayContaining([
        { mountPath: "/app", name: "user-workdir" },
        { mountPath: "/root/.local/share/opencode", name: "opencode-share" },
        { mountPath: "/root/.config/opencode", name: "opencode-config" },
      ]),
    );
    expect(podSpec.volumes).toEqual(
      expect.arrayContaining([
        { hostPath: { path: "/nas/agent-master/users/user-a", type: "DirectoryOrCreate" }, name: "user-workdir" },
        { hostPath: { path: "/nas/agent-master/users/user-a/.runtime/opencode/share", type: "DirectoryOrCreate" }, name: "opencode-share" },
        { hostPath: { path: "/nas/agent-master/users/user-a/.runtime/opencode/config", type: "DirectoryOrCreate" }, name: "opencode-config" },
        { hostPath: { path: "/nas/agent-presets/coding", type: "Directory" }, name: "agent-preset-coding-source" },
      ]),
    );
    expect(podSpec.terminationGracePeriodSeconds).toBe(60);
    expect(runtimeContainer.lifecycle.preStop.exec.command).toEqual(["/bin/sh", "-c", "sleep 5"]);
    expect(initContainer.volumeMounts).toContainEqual({ mountPath: "/agent-preset-config/coding", name: "agent-preset-coding-source", readOnly: true });
    expect(runtimeContainer.volumeMounts).not.toContainEqual(expect.objectContaining({ name: "agent-preset-coding-source" }));
    expect(JSON.stringify(deployment)).not.toContain("scene-coding-agents");
    expect(JSON.stringify(deployment)).not.toContain("/nas/agent-master/users/user-a/.runtime/instances");
    expect(runtimeContainer.resources).toMatchObject({
      limits: { cpu: "500m", memory: "1Gi" },
      requests: { cpu: "100m", memory: "512Mi" },
    });
  });
});

describe("RuntimeServiceFetchProxy", () => {
  test("returns event stream without buffering SSE response", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: ping\\n\\n"));
      },
    });
    const proxy = new RuntimeServiceFetchProxy({
      fetch: async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
      namespace: "agent-runtime",
    });

    const response = await proxy.forward({
      headers: {},
      method: "GET",
      path: "/event",
      query: {},
      serviceName: "opencode-rt-000001",
      servicePort: 4096,
    });

    expect(response.isEventStream).toBe(true);
    expect(response.stream).toBeDefined();
    expect(response.body).toBeUndefined();
  });

  test("forwards request to runtime service and strips authorization", async () => {
    const requests: Request[] = [];
    const proxy = new RuntimeServiceFetchProxy({
      fetch: async (request) => {
        requests.push(request);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 202,
        });
      },
      namespace: "agent-runtime",
    });

    const response = await proxy.forward({
      body: { title: "hello" },
      headers: { authorization: "Bearer secret", "x-user-id": "user-a" },
      method: "POST",
      path: "/session",
      query: { directory: "/app/coding" },
      serviceName: "opencode-rt-000001",
      servicePort: 4096,
    });

    expect(response.statusCode).toBe(202);
    expect(requests[0]?.url).toBe("http://opencode-rt-000001.agent-runtime.svc.cluster.local:4096/session?directory=%2Fapp%2Fcoding");
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(requests[0]?.headers.get("x-user-id")).toBe("user-a");
  });
});

describe("production dependency builder", () => {
  test("builds production dependencies instead of failing fast", async () => {
    const dependencies = buildProductionRuntimeDependencies({
      config: parseProductionConfig(`
server:
  port: 3000
  host: 0.0.0.0
  log: info
redis:
  host: redis
  port: 6379
  db: 0
  key: agent-runtime:user
  password: ""
runtime:
  image: ghcr.io/archaiharness/agent-runtime:latest
  ttl: 3600
  timeout: 60000
  port: 4096
  workdir: /nas/agent-master/users
  agentPresets:
    coding: /nas/agent-master/agent-presets/coding
nas:
  path: /nas/agent-master
kubernetes:
  cluster: default
  namespace: agent-runtime
  clusters:
    - name: default
      namespace: agent-runtime
      auth: inCluster
      scheduling:
        enabled: true
        maxRuntime: 100
`),
      kubernetesHttpClient: new RecordingKubernetesHttpClient(),
      redisClient: new RecordingRedisClient(),
    });

    expect(dependencies.runtimePort).toBe(4096);
    expect(dependencies.agentPresets).toEqual({ coding: "/nas/agent-master/agent-presets/coding" });
    expect(await dependencies.workload.checkCapacity({ cluster: "default", namespace: "agent-runtime" })).toMatchObject({
      allowed: true,
    });
  });

  test("passes configured maxRuntime into Kubernetes workload adapter", async () => {
    const dependencies = buildProductionRuntimeDependencies({
      config: parseProductionConfig(`
server:
  port: 3000
  host: 0.0.0.0
  log: info
redis:
  host: redis
  port: 6379
  db: 0
  key: agent-runtime:user
  password: ""
runtime:
  image: ghcr.io/archaiharness/agent-runtime:latest
  ttl: 3600
  timeout: 60000
  port: 4096
  workdir: /nas/agent-master/users
  agentPresets:
    coding: /nas/agent-master/agent-presets/coding
nas:
  path: /nas/agent-master
kubernetes:
  cluster: default
  namespace: agent-runtime
  clusters:
    - name: default
      namespace: agent-runtime
      auth: inCluster
      scheduling:
        enabled: true
        maxRuntime: 1
`),
      kubernetesHttpClient: new RecordingKubernetesHttpClient({ runtimeDeploymentCount: 1 }),
      redisClient: new RecordingRedisClient(),
    });

    await expect(dependencies.workload.checkCapacity({ cluster: "default", namespace: "agent-runtime" })).resolves.toMatchObject({
      allowed: false,
      reason: "namespace agent-runtime reached max runtime count 1",
    });
  });
});

class RecordingRedisClient implements RedisKeyValueClient {
  selectedDb: number | null = null;
  readonly setCalls: Array<{ key: string; value: string; ttlSeconds: number }> = [];
  readonly deletedKeys: string[] = [];
  private readonly values = new Map<string, string>();

  async select(db: number): Promise<void> {
    this.selectedDb = db;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options: { ttlSeconds: number }): Promise<void> {
    this.setCalls.push({ key, ttlSeconds: options.ttlSeconds, value });
    this.values.set(key, value);
  }

  async setNx(key: string, value: string, options: { ttlSeconds: number }): Promise<boolean> {
    if (this.values.has(key)) {
      return false;
    }
    this.setCalls.push({ key, ttlSeconds: options.ttlSeconds, value });
    this.values.set(key, value);
    return true;
  }

  async del(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.values.delete(key);
  }
}

class RecordingKubernetesHttpClient {
  readonly requests: Array<{ method: string; path: string; body?: unknown; contentType?: string }> = [];

  constructor(
    private readonly options: {
      deploymentUnavailable?: boolean;
      limitMaxMemory?: string;
      nodeMemoryPressure?: boolean;
      quotaPodsHard?: string;
      quotaPodsUsed?: string;
      quotaServicesHard?: string;
      quotaServicesUsed?: string;
      runtimeDeploymentCount?: number;
    } = {},
  ) {}

  async request(input: { method: string; path: string; body?: unknown; contentType?: string }): Promise<unknown> {
    this.requests.push(input);
    if (input.method === "GET" && input.path.includes("/deployments/")) {
      return {
        metadata: { generation: 1 },
        status: {
          availableReplicas: 1,
          observedGeneration: 1,
          readyReplicas: 1,
        },
      };
    }
    if (input.method === "GET" && input.path === "/api/v1/nodes") {
      return {
        items: [
          {
            spec: { unschedulable: false },
            status: {
              allocatable: { cpu: "4", memory: "8Gi", pods: "110" },
              conditions: [
                { status: "True", type: "Ready" },
                { status: this.options.nodeMemoryPressure ? "True" : "False", type: "MemoryPressure" },
                { status: "False", type: "DiskPressure" },
                { status: "False", type: "PIDPressure" },
              ],
            },
          },
        ],
      };
    }
    if (input.method === "GET" && input.path.endsWith("/resourcequotas")) {
      return {
        items: [
          {
            status: {
              hard: {
                pods: this.options.quotaPodsHard ?? "100",
                "requests.cpu": "1000m",
                "requests.memory": "2Gi",
                services: this.options.quotaServicesHard ?? "10",
              },
              used: {
                pods: this.options.quotaPodsUsed ?? "1",
                "requests.cpu": "100m",
                "requests.memory": "128Mi",
                services: this.options.quotaServicesUsed ?? "1",
              },
            },
          },
        ],
      };
    }
    if (input.method === "GET" && input.path.endsWith("/limitranges")) {
      return {
        items: [
          {
            spec: {
              limits: [
                {
                  max: { memory: this.options.limitMaxMemory ?? "2Gi" },
                  min: { cpu: "10m", memory: "32Mi" },
                  type: "Container",
                },
              ],
            },
          },
        ],
      };
    }
    if (input.method === "GET" && input.path.includes("/pods?")) {
      return { items: [{ status: { phase: "Running", conditions: [{ status: "True", type: "Ready" }] } }] };
    }
    if (input.method === "GET" && input.path.includes("/deployments?")) {
      return {
        items: Array.from({ length: this.options.runtimeDeploymentCount ?? 1 }, (_, index) => ({
          metadata: { name: `opencode-runtime-${index}` },
          status: {
            conditions: [
              { status: this.options.deploymentUnavailable ? "False" : "True", type: "Available" },
              { status: "True", type: "Progressing" },
            ],
          },
        })),
      };
    }
    if (input.method === "GET" && input.path.includes("/events?")) {
      return { items: [] };
    }
    return {};
  }
}
