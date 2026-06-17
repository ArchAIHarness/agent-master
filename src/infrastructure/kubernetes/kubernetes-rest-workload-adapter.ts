import type { RuntimeSnapshot } from "../../domain/runtime/runtime";
import type { RuntimeWorkloadPort, RuntimeWorkloadSpec } from "../../ports/runtime-workload-port";

export interface KubernetesHttpClient {
  request(input: { method: string; path: string; body?: unknown; contentType?: string }): Promise<unknown>;
}

export interface KubernetesRestWorkloadAdapterOptions {
  readonly http: KubernetesHttpClient;
  readonly maxRuntimePerNamespace?: number;
  readonly readyPollIntervalMs?: number;
  readonly readyTimeoutMs?: number;
}

const runtimeResourceRequest = {
  cpu: 0.1,
  cpuText: "100m",
  memory: 512 * 1024 * 1024,
  memoryText: "512Mi",
  pods: 1,
  services: 1,
};

const runtimeResourceLimit = {
  cpuText: "500m",
  memoryText: "1Gi",
};

export class KubernetesRestWorkloadAdapter implements RuntimeWorkloadPort {
  constructor(private readonly options: KubernetesRestWorkloadAdapterOptions) {}

  async checkCapacity(input: { cluster: string; namespace: string }): Promise<{ allowed: boolean; reason?: string }> {
    const namespace = await this.options.http.request({
      method: "GET",
      path: `/api/v1/namespaces/${input.namespace}`,
    });
    if (!namespace) {
      return { allowed: false, reason: `namespace ${input.namespace} was not found` };
    }

    const nodes = await this.options.http.request({ method: "GET", path: "/api/v1/nodes" });
    if (!hasSchedulableNodeWithResources(nodes)) {
      return { allowed: false, reason: `cluster ${input.cluster} has no schedulable node with enough resources` };
    }

    const quotas = await this.options.http.request({ method: "GET", path: `/api/v1/namespaces/${input.namespace}/resourcequotas` });
    const quotaReason = findExhaustedQuotaReason(quotas, input.namespace);
    if (quotaReason) {
      return { allowed: false, reason: quotaReason };
    }

    const limitRanges = await this.options.http.request({ method: "GET", path: `/api/v1/namespaces/${input.namespace}/limitranges` });
    const limitRangeReason = findLimitRangeViolationReason(limitRanges, input.namespace);
    if (limitRangeReason) {
      return { allowed: false, reason: limitRangeReason };
    }

    const pods = await this.options.http.request({
      method: "GET",
      path: `/api/v1/namespaces/${input.namespace}/pods?labelSelector=app%3Dopencode-runtime`,
    });
    const podReason = findUnreadyRuntimePodReason(pods, input.namespace);
    if (podReason) {
      return { allowed: false, reason: podReason };
    }

    const deployments = await this.options.http.request({
      method: "GET",
      path: `/apis/apps/v1/namespaces/${input.namespace}/deployments?labelSelector=app%3Dopencode-runtime`,
    });
    const deploymentReason = findRuntimeDeploymentReason(deployments, input.namespace, this.options.maxRuntimePerNamespace);
    if (deploymentReason) {
      return { allowed: false, reason: deploymentReason };
    }

    const events = await this.options.http.request({
      method: "GET",
      path: `/api/v1/namespaces/${input.namespace}/events?fieldSelector=type%3DWarning`,
    });
    if (hasWarningEvents(events)) {
      return { allowed: false, reason: `namespace ${input.namespace} has warning events` };
    }

    return { allowed: true };
  }

  async createDeployment(spec: RuntimeWorkloadSpec): Promise<void> {
    await this.options.http.request({
      body: buildDeploymentManifest(spec),
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

function hasSchedulableNodeWithResources(value: unknown): boolean {
  const items = readItems(value);
  return items.some((item) => {
    if (isObjectRecord(item.spec) && item.spec.unschedulable === true) {
      return false;
    }
    if (!isObjectRecord(item.status)) {
      return false;
    }
    const conditions = Array.isArray(item.status.conditions) ? item.status.conditions : [];
    const ready = conditions.some(
      (condition) => isObjectRecord(condition) && condition.type === "Ready" && condition.status === "True",
    );
    const pressured = conditions.some(
      (condition) =>
        isObjectRecord(condition) &&
        ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(String(condition.type)) &&
        condition.status === "True",
    );
    const allocatable = isObjectRecord(item.status.allocatable) ? item.status.allocatable : {};
    const cpu = parseQuantity(allocatable.cpu);
    const memory = parseQuantity(allocatable.memory);
    const pods = parseQuantity(allocatable.pods);
    return (
      ready &&
      !pressured &&
      (cpu === undefined || cpu >= runtimeResourceRequest.cpu) &&
      (memory === undefined || memory >= runtimeResourceRequest.memory) &&
      (pods === undefined || pods >= runtimeResourceRequest.pods)
    );
  });
}

function findExhaustedQuotaReason(value: unknown, namespace: string): string | undefined {
  for (const quota of readItems(value)) {
    if (!isObjectRecord(quota.status)) {
      continue;
    }
    const hard = isObjectRecord(quota.status.hard) ? quota.status.hard : {};
    const used = isObjectRecord(quota.status.used) ? quota.status.used : {};
    const checks: Array<{ name: string; request: number; hard: unknown; used: unknown }> = [
      { hard: hard.pods, name: "pods", request: runtimeResourceRequest.pods, used: used.pods },
      { hard: hard.services, name: "services", request: runtimeResourceRequest.services, used: used.services },
      { hard: hard["requests.cpu"], name: "requests.cpu", request: runtimeResourceRequest.cpu, used: used["requests.cpu"] },
      {
        hard: hard["requests.memory"],
        name: "requests.memory",
        request: runtimeResourceRequest.memory,
        used: used["requests.memory"],
      },
      { hard: hard["limits.cpu"], name: "limits.cpu", request: runtimeResourceRequest.cpu, used: used["limits.cpu"] },
      {
        hard: hard["limits.memory"],
        name: "limits.memory",
        request: runtimeResourceRequest.memory,
        used: used["limits.memory"],
      },
    ];
    for (const check of checks) {
      const hardValue = parseQuantity(check.hard);
      const usedValue = parseQuantity(check.used);
      if (hardValue !== undefined && usedValue !== undefined && usedValue + check.request > hardValue) {
        return `namespace ${namespace} quota ${check.name} is exhausted`;
      }
    }
  }
  return undefined;
}

function findLimitRangeViolationReason(value: unknown, namespace: string): string | undefined {
  for (const limitRange of readItems(value)) {
    if (!isObjectRecord(limitRange.spec) || !Array.isArray(limitRange.spec.limits)) {
      continue;
    }
    for (const limit of limitRange.spec.limits) {
      if (!isObjectRecord(limit) || limit.type !== "Container") {
        continue;
      }
      const max = isObjectRecord(limit.max) ? limit.max : {};
      const min = isObjectRecord(limit.min) ? limit.min : {};
      const maxMemory = parseQuantity(max.memory);
      const maxCpu = parseQuantity(max.cpu);
      const minMemory = parseQuantity(min.memory);
      const minCpu = parseQuantity(min.cpu);
      if (maxMemory !== undefined && maxMemory < runtimeResourceRequest.memory) {
        return `namespace ${namespace} LimitRange max memory is below runtime request`;
      }
      if (maxCpu !== undefined && maxCpu < runtimeResourceRequest.cpu) {
        return `namespace ${namespace} LimitRange max cpu is below runtime request`;
      }
      if (minMemory !== undefined && minMemory > runtimeResourceRequest.memory) {
        return `namespace ${namespace} LimitRange min memory is above runtime request`;
      }
      if (minCpu !== undefined && minCpu > runtimeResourceRequest.cpu) {
        return `namespace ${namespace} LimitRange min cpu is above runtime request`;
      }
    }
  }
  return undefined;
}

function findUnreadyRuntimePodReason(value: unknown, namespace: string): string | undefined {
  for (const pod of readItems(value)) {
    if (!isObjectRecord(pod.status)) {
      continue;
    }
    const phase = typeof pod.status.phase === "string" ? pod.status.phase : "";
    const conditions = Array.isArray(pod.status.conditions) ? pod.status.conditions : [];
    const ready = conditions.some(
      (condition) =>
        isObjectRecord(condition) && condition.type === "Ready" && condition.status === "True",
    );
    if (phase !== "Running" || !ready) {
      return `namespace ${namespace} has unready runtime pods`;
    }
  }
  return undefined;
}

function findRuntimeDeploymentReason(value: unknown, namespace: string, maxRuntimePerNamespace: number | undefined): string | undefined {
  const deployments = readItems(value);
  if (maxRuntimePerNamespace !== undefined && deployments.length >= maxRuntimePerNamespace) {
    return `namespace ${namespace} reached max runtime count ${maxRuntimePerNamespace}`;
  }
  const unhealthy = deployments.some((deployment) => {
    if (!isObjectRecord(deployment.status)) {
      return false;
    }
    const conditions = Array.isArray(deployment.status.conditions) ? deployment.status.conditions : [];
    return conditions.some(
      (condition) =>
        isObjectRecord(condition) &&
        ((condition.type === "Available" && condition.status === "False") ||
          (condition.type === "Progressing" && condition.status === "False")),
    );
  });
  return unhealthy ? `namespace ${namespace} has unhealthy runtime deployments` : undefined;
}

 function hasWarningEvents(value: unknown): boolean {
   // Only block on critical quota/resource warnings, not image pull warnings
   // Image pull warnings are expected for local-built images and will be retried
   const items = readItems(value);
   return items.some(item => {
     if (!isObjectRecord(item) || typeof item.message !== 'string') {
       return false;
     }
     // Block only resource quota exhausted, limit range violations
     // Allow image pull warnings for local images
     const message = item.message.toLowerCase();
     return message.includes('quota') && message.includes('exhausted') ||
            message.includes('limitrange') && message.includes('violates');
   });
 }

function readItems(value: unknown): Record<string, unknown>[] {
  if (!isObjectRecord(value) || !Array.isArray(value.items)) {
    return [];
  }
  return value.items.filter(isObjectRecord);
}

function parseQuantity(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const match = /^(?<amount>\d+(?:\.\d+)?)(?<suffix>m|ki|mi|gi)?$/.exec(normalized);
  if (!match?.groups) {
    return undefined;
  }
  const amount = Number(match.groups.amount);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  switch (match.groups.suffix) {
    case "m":
      return amount / 1000;
    case "ki":
      return amount * 1024;
    case "mi":
      return amount * 1024 * 1024;
    case "gi":
      return amount * 1024 * 1024 * 1024;
    default:
      return amount;
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

function buildDeploymentManifest(spec: RuntimeWorkloadSpec): unknown {
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
                  name: "user-workdir",
                },
                {
                  mountPath: "/root/.local/share/opencode",
                  name: "opencode-data",
                },
                {
                  mountPath: "/root/.config/opencode",
                  name: "opencode-config",
                },
                {
                  mountPath: "/root/.cache/opencode",
                  name: "opencode-cache",
                },
              ],
            },
          ],
           containers: [
             {
               args: [buildOpenCodeStartupCommand(spec.runtime.targetPort)],
               command: ["/bin/sh", "-c"],
               image: spec.image,
               imagePullPolicy: "IfNotPresent",
               name: "opencode-runtime",
               ports: [{ containerPort: spec.runtime.targetPort, name: "http" }],
              lifecycle: {
                preStop: {
                  exec: {
                    command: ["/bin/sh", "-c", "sleep 5"],
                  },
                },
              },
              resources: {
                limits: {
                  cpu: runtimeResourceLimit.cpuText,
                  memory: runtimeResourceLimit.memoryText,
                },
                requests: {
                  cpu: runtimeResourceRequest.cpuText,
                  memory: runtimeResourceRequest.memoryText,
                },
              },
              volumeMounts: [
                {
                  mountPath: "/app",
                  name: "user-workdir",
                },
                {
                  mountPath: "/root/.local/share/opencode",
                  name: "opencode-data",
                },
                {
                  mountPath: "/root/.config/opencode",
                  name: "opencode-config",
                },
                {
                  mountPath: "/root/.cache/opencode",
                  name: "opencode-cache",
                },
              ],
            },
          ],
          volumes: [
            {
              hostPath: {
                path: spec.runtime.workspaceRootPath,
                type: "DirectoryOrCreate",
              },
              name: "user-workdir",
            },
            {
              hostPath: {
                path: `${spec.runtime.workspaceRootPath}/.runtime/opencode/data`,
                type: "DirectoryOrCreate",
              },
              name: "opencode-data",
            },
            {
              hostPath: {
                path: `${spec.runtime.workspaceRootPath}/.runtime/opencode/config`,
                type: "DirectoryOrCreate",
              },
              name: "opencode-config",
            },
            {
              hostPath: {
                path: `${spec.runtime.workspaceRootPath}/.runtime/opencode/cache`,
                type: "DirectoryOrCreate",
              },
              name: "opencode-cache",
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
    "mkdir -p /app/.runtime/opencode/data",
    "mkdir -p /app/.runtime/opencode/config",
    "mkdir -p /app/.runtime/opencode/cache",
  ];
  return commands.join(" && ");
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildOpenCodeStartupCommand(targetPort: number): string {
  const command = `opencode web --port ${targetPort} --hostname 0.0.0.0`;
  return [
    "set -u",
    command,
    "status=$?",
    "if [ $status -eq 0 ] || [ $status -eq 130 ] || [ $status -eq 143 ]; then exit $status; fi",
    "stamp=$(date +%Y%m%d%H%M%S)",
    "mkdir -p /root/.config/opencode/.quarantine",
    "mkdir -p /root/.config/opencode/.recovered",
    'for item in /root/.config/opencode/* /root/.config/opencode/.[!.]* /root/.config/opencode/..?*; do [ -e "$item" ] || continue; name=$(basename "$item"); [ "$name" = ".quarantine" ] && continue; [ "$name" = ".recovered" ] && continue; mv "$item" /root/.config/opencode/.quarantine/"$stamp-$name"; done',
    "echo '{}' > /root/.config/opencode/opencode.jsonc",
    'echo "OpenCode config was quarantined after startup failure $status; retrying with minimal config" >&2',
    command,
  ].join("; ");
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
      ],
      selector: runtime.podSelector,
      type: "ClusterIP",
    },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
