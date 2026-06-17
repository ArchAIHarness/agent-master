import { RuntimeAggregate } from "../../domain/runtime/runtime";
import { RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";
import type { RuntimeClock } from "../../ports/runtime-clock";
import type {
  RuntimeAgentProxyPort,
  RuntimeProxyHeaders,
  RuntimeProxyQuery,
  RuntimeProxyResponse,
} from "../../ports/runtime-agent-proxy-port";
import type { RuntimeEventBus } from "../../ports/runtime-event-bus";
import type { RuntimeStore } from "../../ports/runtime-store";

export interface RuntimeWebUiProxyServiceDependencies {
  readonly clock: RuntimeClock;
  readonly eventBus: RuntimeEventBus;
  readonly proxy: RuntimeAgentProxyPort;
  readonly store: RuntimeStore;
  readonly ttlSeconds: number;
  /** WebUI port exposed by the runtime container (e.g. AionUi default 3000). */
  readonly webuiPort: number;
  /** Path prefix exposed by master to the browser (e.g. "/webui"). */
  readonly pathPrefix: string;
}

export interface RuntimeWebUiProxyInput {
  readonly userId: string;
  readonly method: string;
  readonly path: string;
  readonly query: RuntimeProxyQuery;
  readonly headers: Record<string, string | undefined>;
  readonly body?: unknown;
}

export class RuntimeWebUiProxyService {
  constructor(private readonly dependencies: RuntimeWebUiProxyServiceDependencies) {}

  startSseLeaseRenewal(input: { userId: string; intervalMs?: number }): () => void {
    const interval = setInterval(() => {
      void this.renewLease(input.userId);
    }, input.intervalMs ?? 300_000);
    return () => clearInterval(interval);
  }

  async proxy(input: RuntimeWebUiProxyInput): Promise<RuntimeProxyResponse> {
    const runtime = await this.dependencies.store.getByUserId(input.userId);
    if (!runtime || runtime.status !== "running") {
      throw new RuntimeNotFoundError(input.userId);
    }

    const headers = stripWebUiUpstreamHeaders(input.headers);
    const response = await this.dependencies.proxy.forward({
      body: input.body,
      headers,
      method: input.method,
      path: input.path,
      query: input.query,
      serviceName: runtime.serviceName,
      servicePort: this.dependencies.webuiPort,
    });

    await this.renewLease(input.userId);
    return rewriteWebUiResponseHeaders(response, this.dependencies.pathPrefix);
  }

  private async renewLease(userId: string): Promise<void> {
    const snapshot = await this.dependencies.store.getByUserId(userId);
    if (!snapshot) {
      return;
    }
    const runtime = RuntimeAggregate.rehydrate(snapshot);
    runtime.extendLease(this.dependencies.clock.plusSeconds(this.dependencies.ttlSeconds));
    for (const event of runtime.pullEvents()) {
      await this.dependencies.eventBus.publish(event);
    }
    await this.dependencies.store.save(runtime.snapshot());
  }
}

const WEBUI_REQUEST_BLOCKED_HEADERS = new Set([
  "authorization",
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-user-id",
]);

function stripWebUiUpstreamHeaders(headers: Record<string, string | undefined>): RuntimeProxyHeaders {
  const filtered: RuntimeProxyHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (WEBUI_REQUEST_BLOCKED_HEADERS.has(normalized)) {
      continue;
    }
    filtered[normalized] = value;
  }
  return filtered;
}

const WEBUI_RESPONSE_BLOCKED_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function rewriteWebUiResponseHeaders(
  response: RuntimeProxyResponse,
  pathPrefix: string,
): RuntimeProxyResponse {
  const normalizedPrefix = normalizePathPrefix(pathPrefix);
  const rewritten: RuntimeProxyHeaders = {};
  for (const [name, value] of Object.entries(response.headers)) {
    const normalized = name.toLowerCase();
    if (WEBUI_RESPONSE_BLOCKED_HEADERS.has(normalized)) {
      continue;
    }
    if (normalized === "set-cookie") {
      rewritten[name] = rewriteSetCookieHeader(value, normalizedPrefix);
      continue;
    }
    rewritten[name] = value;
  }
  return { ...response, headers: rewritten };
}

const COOKIE_PATH_PATTERN = /(;\s*Path\s*=\s*)[^;]*/i;

function rewriteSetCookieHeader(rawSetCookie: string, normalizedPrefix: string): string {
  const cookies = splitSetCookieHeader(rawSetCookie);
  return cookies.map((cookie) => rewriteSingleCookiePath(cookie, normalizedPrefix)).join(", ");
}

function rewriteSingleCookiePath(cookie: string, normalizedPrefix: string): string {
  if (COOKIE_PATH_PATTERN.test(cookie)) {
    return cookie.replace(COOKIE_PATH_PATTERN, (_match, prefix: string) => `${prefix}${normalizedPrefix}`);
  }
  return `${cookie}; Path=${normalizedPrefix}`;
}

function normalizePathPrefix(prefix: string): string {
  if (!prefix) {
    return "/";
  }
  const stripped = prefix.replace(/\/+$/, "");
  if (stripped.length === 0) {
    return "/";
  }
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function splitSetCookieHeader(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < value.length) {
    const char = value[i] ?? "";
    if (char === "," && i + 1 < value.length && value[i + 1] === " ") {
      const remainder = value.slice(i + 2);
      if (looksLikeNewCookie(remainder)) {
        parts.push(current);
        current = "";
        i += 2;
        continue;
      }
    }
    current += char;
    i += 1;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

function looksLikeNewCookie(remainder: string): boolean {
  const semi = remainder.indexOf(";");
  const head = semi < 0 ? remainder : remainder.slice(0, semi);
  return /^[\w!#$%&'*+\-.^`|~]+\s*=/.test(head);
}

export function isWebUiSseProxyResponse(response: RuntimeProxyResponse): boolean {
  return Boolean(response.isEventStream);
}
