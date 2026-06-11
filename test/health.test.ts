import { describe, expect, test } from "bun:test";

import { buildApp } from "../src/app";

interface ServiceStatusResponse {
  service: "agent-control";
  status: "ok";
}

describe("health endpoints", () => {
  test("GET /health returns service status", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json<ServiceStatusResponse>()).toEqual({
      service: "agent-control",
      status: "ok",
    });

    await app.close();
  });

  test("GET /ready is not exposed", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
