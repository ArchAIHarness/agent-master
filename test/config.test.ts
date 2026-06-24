import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("loads default service configuration", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
    });
  });
});
