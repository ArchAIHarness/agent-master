import type { RuntimeDependenciesOptions } from "../ports/runtime-dependencies";

export function buildProductionRuntimeDependencies(): RuntimeDependenciesOptions {
  throw new Error(
    "production runtime dependencies are not configured: provide Redis store, Kubernetes workload adapter, Runtime Service proxy, and event bus before enabling Runtime APIs",
  );
}
