import { describe, expect, test } from "bun:test";

import { buildApp } from "../src/app";

interface ServiceStatusResponse {
  service: "agent-master";
  status: "ok";
}

describe("health endpoints", () => {
  test("GET /api/v1/health returns service status", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json<ServiceStatusResponse>()).toEqual({
      service: "agent-master",
      status: "ok",
    });

    await app.close();
  });

  test("legacy health and ready paths are not exposed", async () => {
    const app = buildApp();

    const healthResponse = await app.inject({ method: "GET", url: "/health" });
    const readyResponse = await app.inject({ method: "GET", url: "/ready" });

    expect(healthResponse.statusCode).toBe(404);
    expect(readyResponse.statusCode).toBe(404);

    await app.close();
  });
});
