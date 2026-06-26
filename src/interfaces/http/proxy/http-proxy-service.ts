import http from "node:http";
import httpProxy from "http-proxy";
import type { Request, Response } from "express";
import type { RuntimeStore } from "../../../domain/runtime/runtime-store";

/**
 * HTTP/WebSocket 透明代理服务
 * 封装 http-proxy，提供字节级透明转发
 */
export class HttpProxyService {
  private readonly httpProxy: httpProxy;
  private readonly wsProxy: httpProxy;

  constructor(
    private readonly store: RuntimeStore,
    private readonly namespace: string,
    private readonly webuiPort: number,
    private readonly agentPort: number,
  ) {
    // HTTP 代理：selfHandleResponse 字节级透明转发
    this.httpProxy = httpProxy.createProxyServer({
      changeOrigin: true,
      followRedirects: false,
      selfHandleResponse: true,
    });

    // WebSocket 代理：原生处理
    this.wsProxy = httpProxy.createProxyServer({
      changeOrigin: true,
      followRedirects: false,
      ws: true,
    });

    // HTTP 响应：字节直传
    this.httpProxy.on("proxyRes", (proxyRes, req, res) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    // 统一错误处理
    this.httpProxy.on("error", (err, req, res) => {
      if (res instanceof http.ServerResponse && !res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "PROXY_ERROR", message: err.message }));
      }
    });

    this.wsProxy.on("error", (err, req, socket) => {
      try { socket.destroy(); } catch {}
    });
  }

  /**
   * 代理到 Agent API (4096)
   * /agent/* → 去掉前缀转发
   */
  async proxyAgent(req: Request, res: Response, userId: string): Promise<void> {
    const runtime = await this.store.getByUserId(userId);
    if (!runtime || runtime.status !== "running") {
      res.status(404).json({ code: "RUNTIME_NOT_FOUND", message: `Agent not found for user ${userId}` });
      return;
    }

    const target = `http://agent-${runtime.runtimeId}.${this.namespace}.svc.cluster.local:${this.agentPort}`;
    // Express app.use("/agent") 已经自动去掉了 /agent 前缀
    this.httpProxy.web(req, res, { target });
  }

  /**
   * 代理到 WebUI (8080)
   * *.hostname → 提取 runtimeId 转发
   * 返回 boolean：true = 已处理，false = 未找到 runtime（需要调用 next()）
   */
  async proxyWebui(req: Request, res: Response, runtimeId: string): Promise<boolean> {
    const runtime = await this.store.getByRuntimeId(runtimeId);
    if (!runtime || runtime.status !== "running") {
      return false;
    }

    const target = `http://agent-${runtime.runtimeId}.${this.namespace}.svc.cluster.local:${this.webuiPort}`;
    this.httpProxy.web(req, res, { target });
    return true;
  }

  /**
   * WebSocket 代理到 Agent API (4096)
   */
  async proxyAgentWs(req: http.IncomingMessage, socket: any, head: Buffer, userId: string): Promise<void> {
    const runtime = await this.store.getByUserId(userId);
    if (!runtime || runtime.status !== "running") {
      try { socket.destroy(); } catch {}
      return;
    }

    const target = `http://agent-${runtime.runtimeId}.${this.namespace}.svc.cluster.local:${this.agentPort}`;
    req.url = req.url?.replace(/^\/agent/, "") || "/";
    this.wsProxy.ws(req, socket, head, { target });
  }

  /**
   * WebSocket 代理到 WebUI (8080)
   */
  async proxyWebuiWs(req: http.IncomingMessage, socket: any, head: Buffer, runtimeId: string): Promise<void> {
    const runtime = await this.store.getByRuntimeId(runtimeId);
    if (!runtime || runtime.status !== "running") {
      try { socket.destroy(); } catch {}
      return;
    }

    const target = `http://agent-${runtime.runtimeId}.${this.namespace}.svc.cluster.local:${this.webuiPort}`;
    this.wsProxy.ws(req, socket, head, { target });
  }
}
