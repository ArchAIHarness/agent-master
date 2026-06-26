/**
 * Express 风格 HTTP 全量代理分发器。
 *
 * 拦截 server.emit('request') 和 server.emit('upgrade')，
 * 在请求到达 Fastify 之前直接分流：
 *
 *   /agent/*        → runtime.agentPort（opencode）需要 x-user-id
 *   子域名 Host     → runtime.webuiPort（code-server）从 Host 头提取 runtimeId
 *   其余            → 回退到原始 emit，交给 Fastify
 *
 * WebSocket 升级同样处理。
 *
 * 端口、命名空间来自配置。
 */

import http from "node:http";
import stream from "node:stream";
import httpProxy from "http-proxy";

import type { RuntimeStore } from "../../ports/runtime-store";

// ─── 子域名提取 ────────────────────────────────────

const SUBDOMAIN_PATTERN = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\.([a-zA-Z][a-zA-Z0-9.-]*)(?::\d+)?$/;

function extractRuntimeIdFromHost(host: string | undefined): string | null {
  if (typeof host !== "string") return null;
  const m = host.match(SUBDOMAIN_PATTERN);
  return m ? (m[1] ?? null) : null;
}

function isSubdomain(host: string | undefined): boolean {
  return extractRuntimeIdFromHost(host) !== null;
}

// ─── 配置 ─────────────────────────────────────────

export interface ProxyDispatcherConfig {
  /** K8s 命名空间（构建 service FQDN: agent-{id}.{ns}.svc.cluster.local） */
  readonly namespace: string;
  /** 子域名代理目标端口（webui / code-server） */
  readonly subdomainPort: number;
  /** /agent/* 代理目标端口（opencode） */
  readonly agentPathPort: number;
}

// ─── 分发器 ─────────────────────────────────────

export function createProxyDispatcher(store: RuntimeStore, config: ProxyDispatcherConfig) {
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    selfHandleResponse: true,  // 自己处理响应，http-proxy 不碰压缩
    followRedirects: false,
  });

  // 全量透传：字节级 pipe，不干预压缩、编码、任何内容
  proxy.on("proxyRes", (proxyRes, req, res) => {
    // 原样转发状态码和 headers
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    // 字节级管道，不做任何转换
    proxyRes.pipe(res);
  });

  // 统一错误处理：不崩溃
  proxy.on("error", (err, req: any, res: any) => {
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "PROXY_ERROR", message: err.message }));
    } else if (typeof res.destroy === "function") {
      try { res.destroy(); } catch { /* ignore */ }
    }
  });

  /** 构建 K8s service FQDN */
  function targetUrl(runtimeId: string, port: number): string {
    return `http://agent-${runtimeId}.${config.namespace}.svc.cluster.local:${port}`;
  }

  /** 返回 true = 已处理，false = 需要由 Fastify 处理 */
  function tryProxyRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = req.url ?? "/";

    // ── /agent/*  →  agentPort ─────────────────
    if (url.startsWith("/agent/")) {
      const userId = req.headers["x-user-id"];
      if (!userId || typeof userId !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "MISSING_USER_ID", message: "x-user-id is required" }));
        return true;
      }

      store.getByUserId(userId).then((r) => {
        if (!r || r.status !== "running") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "RUNTIME_NOT_FOUND", message: "Agent not found or not running" }));
          return;
        }
        req.url = url.replace(/^\/agent/, "") || "/";
        proxy.web(req, res, { target: targetUrl(r.runtimeId, config.agentPathPort) });
      }).catch(() => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "runtime lookup failed" }));
        }
      });
      return true;
    }

    // ── 子域名  →  subdomainPort ─────────────
    if (isSubdomain(req.headers.host)) {
      const runtimeId = extractRuntimeIdFromHost(req.headers.host)!;

      store.getByRuntimeId(runtimeId).then((r) => {
        if (!r || r.status !== "running") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "RUNTIME_NOT_FOUND", message: `Runtime ${runtimeId} not found` }));
          return;
        }
        proxy.web(req, res, { target: targetUrl(r.runtimeId, config.subdomainPort) });
      }).catch(() => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "runtime lookup failed" }));
        }
      });
      return true;
    }

    return false; // 让 Fastify 处理
  }

  /** WebSocket 升级 */
  function tryProxyUpgrade(req: http.IncomingMessage, socket: stream.Duplex, head: Buffer): boolean {
    const url = req.url ?? "/";

    if (url.startsWith("/agent/")) {
      const userId = req.headers["x-user-id"];
      if (!userId || typeof userId !== "string") { socket.destroy(); return true; }

      store.getByUserId(userId).then((r) => {
        if (!r || r.status !== "running") { socket.destroy(); return; }
        proxy.ws(req, socket, head, { target: targetUrl(r.runtimeId, config.agentPathPort) });
      }).catch(() => { socket.destroy(); });
      return true;
    }

    if (isSubdomain(req.headers.host)) {
      const runtimeId = extractRuntimeIdFromHost(req.headers.host)!;

      store.getByRuntimeId(runtimeId).then((r) => {
        if (!r || r.status !== "running") { socket.destroy(); return; }
        proxy.ws(req, socket, head, { target: targetUrl(r.runtimeId, config.subdomainPort) });
      }).catch(() => { socket.destroy(); });
      return true;
    }

    return false;
  }

  // ─── install ──────────────────────────────────
  return {
    /**
     * 挂载到 http.Server。
     * 拦截 emit('request') / emit('upgrade') 在 Fastify 之前分流。
     */
    install(server: http.Server): void {
      // 保存 @fastify/websocket 的 upgrade 监听器
      const wsListeners = server.listeners("upgrade");
      for (const l of wsListeners) server.removeListener("upgrade", l);

      const originalEmit = server.emit.bind(server);

      // 覆盖 emit：拦截 request 和 upgrade
      server.emit = function (event: string | symbol, ...args: unknown[]): boolean {
        // request 事件：req, res
        if (event === "request" && args.length >= 2) {
          const req = args[0] as http.IncomingMessage;
          const res = args[1] as http.ServerResponse;
          if (tryProxyRequest(req, res)) return true;
          return originalEmit(event, req, res);
        }

        // upgrade 事件：req, socket, head
        if (event === "upgrade" && args.length >= 3) {
          const req = args[0] as http.IncomingMessage;
          const socket = args[1] as stream.Duplex;
          const head = args[2];
          if (tryProxyUpgrade(req, socket, head as any)) return true;
          for (const l of wsListeners) {
            (l as (...args: unknown[]) => void).call(server, req, socket, head);
          }
          return true;
        }

        // 其他事件直通
        return originalEmit(event as string, ...args);
      };
    },
  };
}
