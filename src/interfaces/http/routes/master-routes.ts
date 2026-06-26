import { Router, Request, Response } from "express";
import type { RuntimeCommandService } from "../../../application/runtime/runtime-command-service";

/**
 * Master 管理 API：/runtime/*
 * 只处理 localhost 主域名的 runtime 生命周期请求
 */
export function createMasterRoutes(commandService: RuntimeCommandService, store: any): Router {
  const router = Router();

  /**
   * POST /runtime
   * 创建当前用户 Agent；已存在则返回当前 Agent
   */
  router.post("/runtime", async (req: Request, res: Response) => {
    try {
      const userId = req.headers["x-user-id"] as string;
      if (!userId) {
        res.status(400).json({ code: "MISSING_USER_ID", message: "x-user-id is required" });
        return;
      }

      const runtime = await commandService.createRuntime({ userId });
      res.status(201).json({
        runtimeId: runtime.runtimeId,
        userId: runtime.userId,
        status: runtime.status,
        namespace: runtime.namespace,
        deploymentName: runtime.deploymentName,
        serviceName: runtime.serviceName,
        leaseExpireAt: runtime.leaseExpireAt,
        webuiUrl: `http://${runtime.runtimeId}.localhost/`,
        agentApiBase: `http://${runtime.runtimeId}.localhost/agent/`,
      });
    } catch (err: any) {
      console.error("Failed to create runtime", err);
      res.status(500).json({ code: "INTERNAL_ERROR", message: err.message });
    }
  });

  /**
   * GET /runtime
   * 查询当前用户 Agent 状态
   */
  router.get("/runtime", async (req: Request, res: Response) => {
    try {
      const userId = req.headers["x-user-id"] as string;
      if (!userId) {
        res.status(400).json({ code: "MISSING_USER_ID", message: "x-user-id is required" });
        return;
      }

      const runtime = await store.getByUserId(userId);
      if (!runtime) {
        res.status(404).json({ code: "RUNTIME_NOT_FOUND", message: `Runtime not found for user ${userId}` });
        return;
      }

      res.json({
        runtimeId: runtime.runtimeId,
        userId: runtime.userId,
        status: runtime.status,
        namespace: runtime.namespace,
        deploymentName: runtime.deploymentName,
        serviceName: runtime.serviceName,
        leaseExpireAt: runtime.leaseExpireAt,
        webuiUrl: `http://${runtime.runtimeId}.localhost/`,
        agentApiBase: `http://${runtime.runtimeId}.localhost/agent/`,
      });
    } catch (err: any) {
      console.error("Failed to get runtime", err);
      res.status(500).json({ code: "INTERNAL_ERROR", message: err.message });
    }
  });

  /**
   * DELETE /runtime
   * 关闭当前用户 Agent
   */
  router.delete("/runtime", async (req: Request, res: Response) => {
    try {
      const userId = req.headers["x-user-id"] as string;
      if (!userId) {
        res.status(400).json({ code: "MISSING_USER_ID", message: "x-user-id is required" });
        return;
      }

      await commandService.deleteRuntime({ userId });
      res.status(204).end();
    } catch (err: any) {
      console.error("Failed to delete runtime", err);
      res.status(500).json({ code: "INTERNAL_ERROR", message: err.message });
    }
  });

  /**
   * POST /runtime/restart
   * 重启当前用户 Agent
   */
  router.post("/runtime/restart", async (req: Request, res: Response) => {
    try {
      const userId = req.headers["x-user-id"] as string;
      if (!userId) {
        res.status(400).json({ code: "MISSING_USER_ID", message: "x-user-id is required" });
        return;
      }

      const runtime = await commandService.restartRuntime({
        userId,
        ...(req.body?.reason ? { reason: req.body.reason as string } : {}),
      });

      res.json({
        runtimeId: runtime.runtimeId,
        status: runtime.status,
        webuiUrl: `http://${runtime.runtimeId}.localhost/`,
      });
    } catch (err: any) {
      console.error("Failed to restart runtime", err);
      res.status(500).json({ code: "INTERNAL_ERROR", message: err.message });
    }
  });

  return router;
}
