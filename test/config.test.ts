import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("loads default service configuration", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      clusters: [],
    });
  });

  test("loads Kubernetes clusters from JSON environment value", () => {
    const config = loadConfig({
      K8S_CLUSTERS: JSON.stringify([
        {
          name: "dev",
          apiServer: "https://kubernetes.default.svc",
          namespace: "default",
        },
      ]),
    });

    expect(config.clusters).toEqual([
      {
        name: "dev",
        apiServer: "https://kubernetes.default.svc",
        namespace: "default",
      },
    ]);
  });
});
