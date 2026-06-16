import type { FastifyInstance } from "fastify";

import { requireUserId } from "../../application/runtime/runtime-path-service";
import type { RuntimeCommandService } from "../../application/runtime/runtime-command-service";
import type { RuntimeEventStreamService } from "../../application/runtime/runtime-event-stream-service";
import type { RuntimeQueryService } from "../../application/runtime/runtime-query-service";
import { mapErrorToStatus } from "./http-errors";
import { toRuntimeResponse } from "./runtime-response";
import { formatSseEvent } from "./sse";

export interface RuntimeRoutesDependencies {
  readonly commandService: RuntimeCommandService;
  readonly eventStreamService: RuntimeEventStreamService;
  readonly queryService: RuntimeQueryService;
}

export async function registerRuntimeRoutes(app: FastifyInstance, dependencies: RuntimeRoutesDependencies): Promise<void> {
  app.post("/runtime", async (request, reply) => {
    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      const runtime = await dependencies.commandService.createRuntime({ userId });
      return reply.code(201).send(toRuntimeResponse(runtime));
    } catch (error) {
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  app.get("/runtime", async (request, reply) => {
    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      const runtime = await dependencies.queryService.getRuntime({ userId });
      if (!runtime) {
        return reply.code(404).send({ code: "RUNTIME_NOT_FOUND", message: `runtime for user ${userId} was not found` });
      }
      return reply.send(toRuntimeResponse(runtime));
    } catch (error) {
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  app.delete("/runtime", async (request, reply) => {
    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      await dependencies.commandService.deleteRuntime({ userId });
      return reply.code(204).send();
    } catch (error) {
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  app.post("/runtime/restart", async (request, reply) => {
    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      const body = isObjectRecord(request.body) ? request.body : {};
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      const runtime = await dependencies.commandService.restartRuntime({
        ...(reason ? { reason } : {}),
        userId,
      });
      return reply.send(toRuntimeResponse(runtime));
    } catch (error) {
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  app.get("/runtime/events", async (request, reply) => {
    try {
      const userId = requireUserId(request.headers["x-user-id"] as string | undefined);
      reply.raw.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });

      const unsubscribe = dependencies.eventStreamService.subscribe({
        listener: (event) => {
          reply.raw.write(formatSseEvent(event));
        },
        userId,
      });
      const heartbeatInterval = setInterval(() => {
        void dependencies.eventStreamService.heartbeat({ userId }).then((event) => {
          reply.raw.write(formatSseEvent(event));
        });
      }, 30_000);
      const leaseRenewalInterval = setInterval(() => {
        void dependencies.eventStreamService.renewLease({ userId });
      }, 300_000);
      const cleanup = () => {
        clearInterval(heartbeatInterval);
        clearInterval(leaseRenewalInterval);
        unsubscribe();
      };
      request.raw.once("close", cleanup);

      const heartbeat = await dependencies.eventStreamService.heartbeat({ userId });
      reply.raw.write(formatSseEvent(heartbeat));

      if (request.headers["x-sse-test-once"] === "true") {
        cleanup();
        reply.raw.end();
      }

      return reply;
    } catch (error) {
      const mapped = mapErrorToStatus(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
