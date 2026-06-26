import express from "express";
import http from "node:http";
import type { Request, Response, NextFunction } from "express";
import type { RuntimeDependenciesOptions } from "./application/runtime/dependencies";
import type { RuntimeCommandService } from "./application/runtime/runtime-command-service";
import { HttpProxyService } from "./interfaces/http/proxy/http-proxy-service";
import { createMasterRoutes } from "./interfaces/http/routes/master-routes";

export function buildApp(deps: RuntimeDependenciesOptions & { commandService: RuntimeCommandService }, config: any) {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json());

  // 代理服务实例
  const proxyService = new HttpProxyService(
    deps.store,
    config.kubernetes.namespace,
    config.runtime.webui.port,
    config.runtime.agent.port,
  );

  /**
   * Health check - 必须放在最前面，避免被子域名中间件拦截
   */
  app.get("/health", (req: Request, res: Response) => {
    res.json({ service: "agent-master", status: "ok" });
  });

  /**
   * Layer 1: *.hostname → WebUI 全量代理
   * 必须放在 /agent 和 /runtime 前面
   */
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host;
    if (!host) {
      next();
      return;
    }

    const parts = host.split(".");
    const subdomain = parts.length >= 2 ? parts.at(0) : undefined;
    if (subdomain && !subdomain.includes(":")) {
      // 有子域名（不是端口号）就尝试查 runtime，查到是 running 就代理，否则继续往下走
      const handled = await proxyService.proxyWebui(req, res, subdomain);
      if (handled) return;
    }

    next();
  });

  /**
   * Layer 2: hostname/agent/* → Agent API 代理
   */
  app.use("/agent", async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.headers["x-user-id"] as string;
    if (!userId) {
      res.status(400).json({ code: "MISSING_USER_ID", message: "x-user-id is required" });
      return;
    }

    await proxyService.proxyAgent(req, res, userId);
  });

  /**
   * Layer 3: hostname/runtime → Master 管理 API
   */
  app.use("/", createMasterRoutes(deps.commandService, deps.store));

  /**
   * WebSocket upgrade 处理
   */
  server.on("upgrade", async (req, socket, head) => {
    const host = req.headers.host;
    const url = req.url ?? "/";

    // 1. *.hostname WebSocket → WebUI 代理
    if (host) {
    const parts = host.split(".");
    const subdomain = parts.length >= 2 ? parts.at(0) : undefined;
    if (subdomain) {
      // 有子域名就尝试查 runtime，查到是 running 就代理，否则关闭连接
      await proxyService.proxyWebuiWs(req, socket, head as Buffer, subdomain);
      return;
    }
    }

    // 2. /agent/* WebSocket → Agent API 代理
    if (url.startsWith("/agent/")) {
      const userId = req.headers["x-user-id"] as string;
      if (!userId) {
        try { socket.destroy(); } catch {}
        return;
      }
      await proxyService.proxyAgentWs(req, socket, head as Buffer, userId);
      return;
    }
  });

  return { app, server };
}
