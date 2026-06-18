# AGENTS.md · agent-master

## 1. 服务边界

`agent-master` 是 Agent 控制面服务，负责多 Kubernetes 集群下 OpenCode Agent 工作负载的调度启停，并代理转发对应 Agent API 请求。

AI 在本仓库内工作时，必须先读取 `README.md` 和本文件，再修改代码或文档。

## 2. 必须做什么

- 保持服务聚焦在 Agent 管理、Kubernetes 多集群调度控制、Agent API 代理。
- 新增功能前先写或更新测试。
- 使用 Bun、TypeScript、Fastify、Zod、bun:test 作为当前基础技术栈。
- 配置变更必须同步更新 `README.md` 与服务目录下的 `config.yaml` 设计；服务运行配置按 Kubernetes ConfigMap / Secret / ServiceAccount 方式提供。
- Kubernetes 访问必须通过 adapter/port 边界封装。
- 运行单元必须统一建模为 Deployment（1 副本）+ Service。
- Agent API 代理必须通过 Service 访问 Agent，不直接依赖 Pod IP。
- OpenCode Agent 容器监听端口与 `agent-runtime` 镜像约定为 `4096`，Agent 必须监听 `0.0.0.0` 以便 Service 访问。
- Agent 状态 API 使用 `GET /runtime`，服务基于 `x-user-id` 查询当前用户 Agent 生命周期状态、租约、集群和 Kubernetes 资源映射，不接受 `runtimeId` 查询当前用户 Agent。
- Agent 平台事件 SSE 使用 `GET /runtime/events`，基于 `x-user-id` 推送当前用户 Agent 控制面状态变化和 `runtime.heartbeat` 心跳；心跳默认 30 秒一次，TTL 续约默认 5 分钟一次。
- Agent API 代理入口使用 `/agent/*`，服务基于用户归属查找当前 Agent，不把 `runtimeId` 作为代理入口路径参数。
- 上游完成鉴权后必须通过 `x-user-id` Header 传入用户标识，服务将其作为 `userId` 查找用户归属的 Agent 实例，Redis Key 固定为 `agent-runtime:user:{userId}`。
- `x-user-id` 缺失或为空时，必须拒绝 Agent 创建、查询、关闭和代理请求。
- `x-user-id` 只信任上游网关或上游服务注入，不接受公网客户端绕过上游后直接伪造。
- `Authorization` 由上游处理，本服务不自行解析用户 Token；如请求中仍携带 `Authorization`，禁止向 Agent 透传。
- Agent API 代理必须支持普通 HTTP 与 OpenCode 原生 SSE；OpenCode 原生 SSE 仍走 `/agent/*` 通用代理入口，平台控制面事件使用独立的 `GET /runtime/events`。
- Agent WebSocket 代理走独立入口 `/agent/ws/*`，去掉 `/agent/ws` 前缀后映射到 OpenCode 原生 WebSocket 路径（当前仅放行 `/pty/{ptyID}/connect`）；不允许把 WebSocket 升级请求合并到 `/agent/*` HTTP 代理。
- WebSocket 代理鉴权按以下顺序解析 `userId`：先看 query `x-user-id`，再看 `Sec-WebSocket-Protocol` 子协议 `x-user-id.<userId>`，二者都缺失立即用 close code `1008` 拒绝；不接受公网客户端绕过上游伪造 `x-user-id`。
- WebSocket 代理只把当前用户已 `running` 的 Agent 作为上游目标；查不到 Runtime 时按 `1008 runtime not running` 关闭，不创建、不重启 Agent。
- WebSocket 代理对上游不透传 `Authorization`、`Proxy-Authorization` 与所有 hop-by-hop Header；`Sec-WebSocket-*` 由 ws 客户端自行生成，不复制下游握手 Header。
- WebSocket 代理透传子协议时，必须剥掉 `x-user-id.*` 前缀的子协议，避免把内部凭证语义传到 Agent。
- WebSocket 代理握手成功后立即续约一次 Agent 租约，并按 5 分钟一次的固定节奏续约；任意一端 close、error 必须立即停止续约、关闭对端，不得遗留 setInterval。
- WebSocket 代理只做字节级透明转发，不解析、不缓冲、不修改帧内容；text 帧按 string、binary 帧按 Buffer 按原方向回传。
- Agent API 默认按 OpenCode 官方接口通用透明代理转发到 Agent Service：去掉 `/agent` 前缀，保留后续路径、查询参数、HTTP 方法和请求体。
- `POST /agent/session` 按 OpenCode 官方接口透明代理；`directory` query 参数由调用方显式传入。
- Agent API 代理路径必须以 OpenCode Server 官方 API 为准，优先查询 Agent `/doc` OpenAPI 规范或官方文档，不得自行编造 OpenCode API 路径。
- 多集群调度逻辑必须显式处理 cluster、namespace、资源名称、资源检查结果和错误返回。
- 创建 Agent 前必须通过 Kubernetes Server API 检查候选集群和 Namespace 的资源状态，用于 Agent 容器调度均衡。
- Agent 实例映射、启停状态、租约续约、TTL 回收必须使用 Redis。
- Redis 只做启动后用户 Agent 运行态状态管理；不存配置、会话、消息、文件、凭证、kubeconfig、Token。
- Agent 归属以用户为基本单位。
- NAS 通过 PV/PVC 按用户隔离，Runtime Deployment 禁止使用 `hostPath`，必须使用 `runtime.workspacePvcClaimName` 指定的单个 PVC，并通过 `runtime.workspacePvcSubPathRoot` 拼接用户 subPath：
  - `{runtime.workspacePvcSubPathRoot}/{userId}/runtime` → `/app`（用户工作目录 + `.opencode/` + `AGENTS.md`）
  - `{runtime.workspacePvcSubPathRoot}/{userId}/global` → `~`（OpenCode 全局配置/data/cache 对应用户主目录下 `.config/`、`.local/share/`、`.cache/`）
  - OpenCode 默认路径正好匹配，不需要修改 OpenCode 任何逻辑
- **首次创建 Agent（新用户）必须执行完整初始化**：创建完整目录树 + 从模板拷贝默认 `AGENTS.md` 和 `opencode.json` 到 `runtime/` 目录 + 设置权限；初始化必须在创建 Deployment 之前完成。
- **重启 Agent 只允许做目录存在性检查**：**绝对不允许写任何文件**（`AGENTS.md`、`opencode.json` 即使丢失也不恢复、不覆盖）；重启流程只能执行 `mkdir -p`，不能有 `writeFile`、`createWriteStream` 等操作。
- 所有文件写入操作必须带"不存在才创建"的原子语义：优先用操作系统级 `O_EXCL` 标志，或在写入前做严格的 exists 检查（不得引入检查-写入竞态）。
- **默认模板必须外置**：`AGENTS.md` 和 `opencode.json` 的默认模板必须放在 `resources/` 目录下作为独立文件，禁止硬编码在业务代码字符串中。
- 初始化顺序强制：先创建所有目录 → 再写入默认 `AGENTS.md`（不存在时）→ 再写入默认 `opencode.json`（不存在时）→ 最后统一设置目录权限确保 Agent 容器内可读可写。
- 平台级默认配置（如默认插件列表、默认 model 提供商）由上游控制面在 master 初始化完成后写入到用户的 `opencode.json` 中，master 内置模板只提供最基础的 JSON 骨架，不包含任何业务预设。
- `cache/` 目录由 OpenCode 进程自行管理，初始化时只确保目录存在，不写入任何内容；`data/auth.json` 由 OpenCode 首次连接 provider 时自动生成，初始化流程绝不触碰。
- 平台场景化能力通过 OpenCode 原生 `plugin` 机制承载：用户在 `/app/.opencode/opencode.json` 的 `plugin` 字段声明插件包名，OpenCode 启动时下载并缓存到 `~/.cache/opencode`；master 不持有也不挂载插件源目录。
- 初始化的根本目的是避免 Kubernetes subPath 挂载坑：如果挂载源不存在，K8s 会自动用 root 权限创建空目录/空文件，导致容器内 OpenCode 进程无权限写入。
- 上述镜像、端口、环境变量、卷、挂载路径和安全约束最终必须渲染为 `deploy.yaml`，用于创建或更新 Kubernetes Agent Deployment。
- `deploy.yaml` 中的用户路径必须来自 `x-user-id` 和服务端配置拼接，不接受客户端传入任意挂载路径；不得保存 kubeconfig、Token、证书、Cookie、账号密码或明文密钥。
- 使用 subPath 或文件级映射时，源文件、源目录和目标父目录必须由初始化流程预先创建，避免 Kubernetes 因挂载目标不存在而启动失败。

## 3. 怎么做

 - Agent 创建流程默认生成：
   - `runtimeId`: `rt-{sanitizedUserId}-{4-random-alphanumeric}` → 保证 Kubernetes 名称兼容，同一个用户多次创建不冲突
   - `deploymentName`: `agent-{runtimeId}`
   - `serviceName`: `agent-{runtimeId}`
   - Pod Labels: `app=agent-runtime`, `runtimeId={runtimeId}`, `userId={userId}`
 - 每个 Agent 创建一个 Deployment。
 - 每个 Agent Deployment 固定 `replicas = 1`。
 - 每个 Agent Deployment 配套创建一个 Service。
 - Deployment、Service、Pod 必须通过统一 Labels 绑定到同一个 Agent 实例。
- Agent 实例必须按用户挂载 NAS 工作目录，路径规则为：`{runtime.workdir}/{userId}/runtime -> /app` (subPath)，`{runtime.workdir}/{userId}/global -> ~` (subPath)。
- Agent 启停与 OpenCode `directory` 无关；`directory` 只是 OpenCode 官方接口参数，由调用方显式传入并通过 `/agent/*` 透明透传。
- OpenCode 项目级配置和用户级运行配置由 OpenCode 进程启动时加载；如果用户目录下文件更新，必须重启 Agent 容器 / Pod 才能生效。
- 查询 Agent 状态时，应综合 Deployment、Service、Pod readiness 得出服务状态。
- 创建 Agent 前，应通过 Kubernetes Server API 检查 Node 可用性、资源余量、Namespace ResourceQuota、LimitRange、现有 Agent 分布、Pod readiness 和异常 Event / Condition。
- 调度控制层负责 cluster / namespace 级均衡，不直接替代 Kubernetes Scheduler 的节点调度职责。
- 架构演进优先通过扩展 Kubernetes 集群和 Namespace 分摊 Agent 工作负载，不改变已确认的用户 Agent、NAS 挂载和 Agent API 透明代理逻辑。
- 避免单集群 Agent Deployment 数量持续膨胀导致 Kubernetes Server API 负载过高；当单集群控制面压力上升时，通过新增可调度集群、调整集群权重或扩展 Namespace 容量解决。
- 关闭 Agent 时，应回收 Deployment 与 Service，避免遗留孤儿资源。
- Redis TTL 到期或触发调度删除实例时，必须删除对应 Deployment（1 副本）+ Service，并清理 Redis 映射。
- Redis 是 Agent 状态、资源映射和租约 TTL 的权威存储。
- 创建、查询、关闭以及内部续约必须通过 Redis 做幂等或一致性控制。
- 普通代理请求触发 Agent 租约续约到 1 小时；SSE 长连接存在时周期性续约；连接结束后停止续约，后续由 Redis TTL 到期触发回收。
- Redis 和 `config.yaml` 中不得保存 kubeconfig、Token、证书、明文密钥或完整请求体。
- 测试中不得访问真实 Kubernetes 集群或真实 Redis，应使用 fake adapter、mock client 或 fake store。

## 4. 不能做什么

- 不能把 Agent 直接实现为裸 Pod 管理。
- 不能只创建 Deployment 而不创建 Service。
- 不能把 Deployment 副本数默认为大于 1。
- 不能让代理直接依赖 Pod IP。
- 不能绕过用户归属关系直接按任意 runtimeId 代理访问。
- 不能把不同用户的 NAS 存储路径或 OpenCode 配置挂载混用。
- 不能在 Runtime Deployment 中使用 `hostPath`；用户存储只能通过 PVC + subPath 挂载。
- 不能在请求路径中执行 `kubectl`。
- 不能提交 kubeconfig、Token、证书、`.env` 或真实集群地址。
- 不能把完整平台控制面、审计中心塞进本服务。
- 不能绕过测试声称功能完成。
- 不能实现 `agentPresets` / 预设配置包 / initContainer 复制逻辑；平台场景能力统一通过 OpenCode 原生 `plugin` 机制承载。
- 不能把 `idle` 状态加入状态机；当前只支持 `pending`、`preparing`、`running`、`terminating`、`terminated`、`failed`。

## 5. 验证门禁

 代码变更后必须运行：

```bash
bun test
bun run typecheck
```

若涉及 Kubernetes adapter、Agent 生命周期、Agent API 代理，必须补充对应单元测试或接口测试。

## 6. 本地开发联调端口转发约束

本地开发联调时，`agent-master` 服务 Kubernetes 端口转发遵循：

- 默认本地转发端口固定为 `localhost:3002`
- 端口转发后台执行，不阻塞开发流程
- 重启 Deployment 后端口转发自动断开，需要重新启动端口转发
- 命令参考（后台运行）：

```bash
# 端口转发到 service
pkill -f "kubectl port-forward" && sleep 1 && nohup kubectl -n agent-master port-forward svc/agent-master 3002:3000 > /dev/null 2>&1 &

# 如果 service 不通，直接端口转发到 pod
POD=$(kubectl -n agent-master get pods -l app=agent-master -o name | head -1) && pkill -f "kubectl port-forward" && sleep 1 && nohup kubectl -n agent-master port-forward $POD 3002:3000 > /dev/null 2>&1 &
```
## 7. Git 操作规则

- 必须由用户告知可以操作git后才能执行git提交推送操作。
- 没有用户明确许可，不得私自执行git提交推送操作。