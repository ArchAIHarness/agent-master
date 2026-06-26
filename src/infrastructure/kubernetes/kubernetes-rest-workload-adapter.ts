import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeWorkloadPort, RuntimeWorkloadSpec } from "../../ports/runtime-workload-port";

export interface KubernetesHttpClient {
  request(input: { method: string; path: string; body?: unknown; contentType?: string }): Promise<unknown>;
}

export interface KubernetesResourceConfig {
  readonly cpu: string;
  readonly memory: string;
}

export interface KubernetesRestWorkloadAdapterOptions {
  readonly http: KubernetesHttpClient;
  readonly readyPollIntervalMs?: number;
  readonly readyTimeoutMs?: number;
  readonly workspacePvcClaimName: string;
  readonly workspacePvcSubPathRoot: string;
  readonly resourceRequests?: KubernetesResourceConfig;
  readonly resourceLimits?: KubernetesResourceConfig;
}

const defaultRuntimeResourceRequest: KubernetesResourceConfig = {
  cpu: "100m",
  memory: "512Mi",
};

const defaultRuntimeResourceLimit: KubernetesResourceConfig = {
  cpu: "500m",
  memory: "1Gi",
};

export class KubernetesRestWorkloadAdapter implements RuntimeWorkloadPort {
  private readonly resourceRequests: KubernetesResourceConfig;
  private readonly resourceLimits: KubernetesResourceConfig;

  constructor(private readonly options: KubernetesRestWorkloadAdapterOptions) {
    this.resourceRequests = options.resourceRequests ?? defaultRuntimeResourceRequest;
    this.resourceLimits = options.resourceLimits ?? defaultRuntimeResourceLimit;
  }

  async createDeployment(spec: RuntimeWorkloadSpec): Promise<void> {
    await this.options.http.request({
      body: buildDeploymentManifest(spec, {
        resourceLimits: this.resourceLimits,
        resourceRequests: this.resourceRequests,
        workspacePvcClaimName: this.options.workspacePvcClaimName,
        workspacePvcSubPathRoot: this.options.workspacePvcSubPathRoot,
      }),
      method: "POST",
      path: `/apis/apps/v1/namespaces/${spec.runtime.namespace}/deployments`,
    });
  }

  async createService(spec: RuntimeWorkloadSpec): Promise<void> {
    await this.options.http.request({
      body: buildServiceManifest(spec.runtime),
      method: "POST",
      path: `/api/v1/namespaces/${spec.runtime.namespace}/services`,
    });
  }

  async waitUntilReady(snapshot: RuntimeSnapshot): Promise<void> {
    const timeoutMs = this.options.readyTimeoutMs ?? 60_000;
    const pollIntervalMs = this.options.readyPollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const deployment = await this.options.http.request({
        method: "GET",
        path: `/apis/apps/v1/namespaces/${snapshot.namespace}/deployments/${snapshot.deploymentName}`,
      });
      if (isDeploymentReady(deployment)) {
        return;
      }
      await Bun.sleep(pollIntervalMs);
    }

    throw new Error(`runtime deployment ${snapshot.deploymentName} did not become ready before timeout`);
  }

  async restartDeployment(snapshot: RuntimeSnapshot): Promise<void> {
    await this.options.http.request({
      body: {
        spec: {
          template: {
            metadata: {
              annotations: {
                "agent-master/restartedAt": new Date().toISOString(),
              },
            },
          },
        },
      },
      contentType: "application/strategic-merge-patch+json",
      method: "PATCH",
      path: `/apis/apps/v1/namespaces/${snapshot.namespace}/deployments/${snapshot.deploymentName}`,
    });
  }

  async deleteDeployment(snapshot: RuntimeSnapshot): Promise<void> {
    await this.options.http.request({
      method: "DELETE",
      path: `/apis/apps/v1/namespaces/${snapshot.namespace}/deployments/${snapshot.deploymentName}`,
    });
  }

  async deleteService(snapshot: RuntimeSnapshot): Promise<void> {
    await this.options.http.request({
      method: "DELETE",
      path: `/api/v1/namespaces/${snapshot.namespace}/services/${snapshot.serviceName}`,
    });
  }
}

function isDeploymentReady(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  const status = value.status;
  const metadata = value.metadata;
  if (!isObjectRecord(status)) {
    return false;
  }
  const generation = isObjectRecord(metadata) && typeof metadata.generation === "number" ? metadata.generation : undefined;
  const observedGeneration = typeof status.observedGeneration === "number" ? status.observedGeneration : undefined;
  const availableReplicas = typeof status.availableReplicas === "number" ? status.availableReplicas : 0;
  const readyReplicas = typeof status.readyReplicas === "number" ? status.readyReplicas : 0;
  return availableReplicas >= 1 && readyReplicas >= 1 && (generation === undefined || observedGeneration === generation);
}

function buildDeploymentManifest(
  spec: RuntimeWorkloadSpec,
  storage: {
    readonly workspacePvcClaimName: string;
    readonly workspacePvcSubPathRoot: string;
    readonly resourceRequests: KubernetesResourceConfig;
    readonly resourceLimits: KubernetesResourceConfig;
  },
): unknown {
  const runtimeSubPath = buildWorkspaceSubPath(storage.workspacePvcSubPathRoot, spec.runtime.userId, "runtime");
  const globalSubPath = buildWorkspaceSubPath(storage.workspacePvcSubPathRoot, spec.runtime.userId, "global");

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      labels: spec.runtime.podSelector,
      name: spec.runtime.deploymentName,
      namespace: spec.runtime.namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: spec.runtime.podSelector },
      template: {
        metadata: { labels: spec.runtime.podSelector },
        spec: {
          terminationGracePeriodSeconds: 60,
          initContainers: [
            {
              command: ["/bin/sh", "-c", buildPrepareUserWorkdirCommand()],
              image: "busybox:1.36",
              imagePullPolicy: "IfNotPresent",
              name: "prepare-user-workdir",
              volumeMounts: [
                {
                  mountPath: "/app",
                  name: "user-storage",
                  subPath: runtimeSubPath,
                },
                {
                  mountPath: "/root",
                  name: "user-storage",
                  subPath: globalSubPath,
                },
              ],
            },
          ],
          containers: [
            {
              image: spec.image,
              imagePullPolicy: "IfNotPresent",
              name: "opencode-runtime",
              ports: [
                { containerPort: spec.runtime.targetPort, name: "http" },
                { containerPort: spec.runtime.opencodePort, name: "opencode" },
              ],
              lifecycle: {
                preStop: {
                  exec: {
                    command: ["/bin/sh", "-c", "sleep 5"],
                  },
                },
              },
              resources: {
                limits: {
                  cpu: storage.resourceLimits.cpu,
                  memory: storage.resourceLimits.memory,
                },
                requests: {
                  cpu: storage.resourceRequests.cpu,
                  memory: storage.resourceRequests.memory,
                },
              },
              volumeMounts: [
                {
                  mountPath: "/app",
                  name: "user-storage",
                  subPath: runtimeSubPath,
                },
                {
                  mountPath: "/root",
                  name: "user-storage",
                  subPath: globalSubPath,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "user-storage",
              persistentVolumeClaim: {
                claimName: storage.workspacePvcClaimName,
              },
            },
          ],
        },
      },
    },
  };
}

function buildPrepareUserWorkdirCommand(): string {
  const commands = [
    "mkdir -p /app/.opencode",
    "mkdir -p /root/.config/opencode",
    "mkdir -p /root/.local/share/opencode",
    "mkdir -p /root/.cache/opencode",
  ];
  return commands.join(" && ");
}

function buildWorkspaceSubPath(root: string, userId: string, leaf: "runtime" | "global"): string {
  return [trimSlashes(root), sanitizeSubPathSegment(userId), leaf].filter(Boolean).join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function sanitizeSubPathSegment(value: string): string {
  return value.replaceAll("/", "-");
}

function buildServiceManifest(runtime: RuntimeSnapshot): unknown {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      labels: runtime.podSelector,
      name: runtime.serviceName,
      namespace: runtime.namespace,
    },
    spec: {
      ports: [
        {
          name: "http",
          port: runtime.servicePort,
          targetPort: runtime.targetPort,
        },
        {
          name: "opencode",
          port: runtime.opencodePort,
          targetPort: runtime.opencodePort,
        },
      ],
      selector: runtime.podSelector,
      type: "ClusterIP",
    },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
