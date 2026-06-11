# AGENTS.md · agent-control

## 1. 服务边界

`agent-control` 是 Agent Runtime 控制面服务，负责多 Kubernetes 集群下 OpenCode Agent 工作负载的调度启停，并代理转发对应 Agent API 请求。

AI 在本仓库内工作时，必须先读取 `README.md` 和本文件，再修改代码或文档。

## 2. 必须做什么

- 保持服务聚焦在 Agent Runtime 管理、Kubernetes 多集群调度控制、Agent API 代理。
- 新增功能前先写或更新测试。
- 使用 Bun、TypeScript、Fastify、Zod、bun:test 作为当前基础技术栈。
- 配置变更必须同步更新 `README.md` 与服务目录下的 `config.yaml` 设计；服务运行配置按 Kubernetes ConfigMap / Secret / ServiceAccount 方式提供。
- Kubernetes 访问必须通过 adapter/port 边界封装。
- 运行单元必须统一建模为 Deployment（1 副本）+ Service。
- Agent API 代理必须通过 Service 访问 Runtime，不直接依赖 Pod IP。
- OpenCode Runtime 容器监听端口与 `agent-runtime` 镜像约定为 `4096`，Runtime 必须监听 `0.0.0.0` 以便 Service 访问。
- Runtime 状态 API 使用 `GET /api/v1/runtime`，服务基于 `x-user-id` 查询当前用户 Runtime 生命周期状态、租约、集群和 Kubernetes 资源映射，不接受 `runtimeId` 查询当前用户 Runtime。
- Runtime 平台事件 SSE 使用 `GET /api/v1/runtime/events`，基于 `x-user-id` 推送当前用户 Runtime 控制面状态变化和 `runtime.heartbeat` 心跳；心跳默认 30 秒一次，TTL 续约默认 5 分钟一次。
- Agent API 代理入口使用 `/api/v1/runtime/agent/*`，服务基于用户归属查找当前 Runtime，不把 `runtimeId` 作为代理入口路径参数。
- 上游完成鉴权后必须通过 `x-user-id` Header 传入用户标识，服务将其作为 `userId` 查找用户归属的 Runtime 实例，Redis Key 固定为 `agent-runtime:user:{userId}`。
- `x-user-id` 缺失或为空时，必须拒绝 Runtime 创建、查询、关闭和代理请求。
- `x-user-id` 只信任上游网关或上游服务注入，不接受公网客户端绕过上游后直接伪造。
- `Authorization` 由上游处理，本服务不自行解析用户 Token；如请求中仍携带 `Authorization`，禁止向 Runtime 透传。
- Agent API 代理必须支持普通 HTTP 与 OpenCode 原生 SSE；OpenCode 原生 SSE 仍走 `/api/v1/runtime/agent/*` 通用代理入口，平台控制面事件使用独立的 `GET /api/v1/runtime/events`。
- Agent API 默认按通用透明代理转发到 Runtime Service：去掉 `/api/v1/runtime/agent` 前缀，保留后续路径、查询参数、HTTP 方法和请求体。
- 当前唯一 API 语义特例是 `POST /api/v1/runtime/agent/session`：读取请求体扩展参数 `scene`，校验后转换为 OpenCode 官方 `directory=/app/{scene}` query 参数，并从转发请求体中移除 `scene`。
- Agent API 代理路径必须以 OpenCode Server 官方 API 为准，优先查询 Runtime `/doc` OpenAPI 规范或官方文档，不得自行编造 OpenCode API 路径。
- 多集群调度逻辑必须显式处理 cluster、namespace、资源名称、资源检查结果和错误返回。
- 创建 Runtime 前必须通过 Kubernetes Server API 检查候选集群和 Namespace 的资源状态，用于 Agent 容器调度均衡。
- Runtime 实例映射、启停状态、租约续约、TTL 回收必须使用 Redis。
- Runtime Redis Key 固定为 `agent-runtime:user:{userId}`，Runtime 状态不得把 scene 作为实例归属条件。
- Runtime 实例归属以用户为基本单位。
- `runtime.workdir` 是用户 NAS 工作目录根路径；Kubernetes 启动 Runtime 时必须将 `{runtime.workdir}/{userId}` 挂载到容器内 `/app`。覆盖镜像内 `/app` 是预期行为。
- 用户默认项目规则必须直接位于 `{runtime.workdir}/{userId}/AGENTS.md`，通过 `{runtime.workdir}/{userId} -> /app` 根挂载自然成为容器内 `/app/AGENTS.md`。
- 用户默认项目级 OpenCode 配置必须直接位于 `{runtime.workdir}/{userId}/.opencode`，通过根挂载自然成为容器内 `/app/.opencode`。
- `runtime.scenes` 是预设场景配置映射；`{runtime.scenes.<scene>}` 指向场景配置根目录，目录内必须包含 `AGENTS.md` 和 `.opencode/`。
- Kubernetes 启动 Runtime 时必须挂载 `runtime.scenes` 中声明的所有预设 scene，将每个 `{runtime.scenes.<scene>}/AGENTS.md` 映射到 `/app/{scene}/AGENTS.md`，并将 `{runtime.scenes.<scene>}/.opencode` 挂载到 `/app/{scene}/.opencode`。
- Runtime 创建或重启前，初始化流程必须确保所有挂载依赖路径存在：用户根目录 `{runtime.workdir}/{userId}`、用户默认 `AGENTS.md`、用户默认 `.opencode/`、所有已声明 scene 的用户工作目录 `{runtime.workdir}/{userId}/{scene}/`，以及所有已声明 scene 的预设配置源路径 `{runtime.scenes.<scene>}/AGENTS.md` 与 `{runtime.scenes.<scene>}/.opencode/`。
- 新增 `runtime.scenes` 时，必须先创建用户侧 scene 工作目录 `{runtime.workdir}/{userId}/{scene}/` 和预设配置源路径 `{runtime.scenes.<scene>}/AGENTS.md`、`{runtime.scenes.<scene>}/.opencode/`；后续新建或重启的 Runtime 按最新配置生成 volumeMount。
- `runtime.scenes` 场景配置不配置 `plugins/`、`commands/`、`modes/`；`plugins/` 只放在用户默认项目级配置 `/app/.opencode` 中。
- `runtime.scenes` 的挂载目标固定为 `/app/{scene}/AGENTS.md` 和 `/app/{scene}/.opencode`，用户场景工作目录 `/app/{scene}` 保持承载工作文件和运行产物。
- `/app/{scene}/AGENTS.md` 和 `/app/{scene}/.opencode` 由 `runtime.scenes` 映射管理；用户 scene 工作目录中的业务文件和运行产物放在上述两个配置路径之外。
- `runtime.scenes.<scene>` 源目录包含 `AGENTS.md` 和 `.opencode/`；渲染时将 `AGENTS.md` 映射到 `/app/{scene}/AGENTS.md`，将 `.opencode/` 挂载到 `/app/{scene}/.opencode`。
- 上述镜像、端口、环境变量、卷、挂载路径和安全约束最终必须渲染为 `deploy.yaml`，用于创建或更新 Kubernetes Runtime Deployment。
- `deploy.yaml` 中的用户路径必须来自 `x-user-id` 和服务端配置拼接，不接受客户端传入任意挂载路径；不得保存 kubeconfig、Token、证书、Cookie、账号密码或明文密钥。
- 使用 subPath 或文件级映射时，源文件、源目录和目标父目录必须由初始化流程预先创建，避免 Kubernetes 因挂载目标不存在而启动失败。

## 3. 怎么做

- Runtime 创建流程默认生成：
  - Runtime 实例 ID。
  - Deployment 名称。
  - Service 名称。
  - Pod Labels / Selector。
- 每个 Runtime 创建一个 Deployment。
- 每个 Runtime Deployment 固定 `replicas = 1`。
- 每个 Runtime Deployment 配套创建一个 Service。
- Deployment、Service、Pod 必须通过统一 Labels 绑定到同一个 Runtime 实例。
- Runtime 实例必须按用户挂载 NAS 工作目录，路径规则为 `{runtime.workdir}/{userId} -> /app`。
- Runtime 启停与 scene 无关；scene 是 `agent-control` 的会话级扩展参数，用于拼接 OpenCode 会话目录。
- OpenCode 会话创建时可以读取请求体 `scene`，但只能用于校验预设集合并拼接容器内目录 `/app/{scene}`；代理转发时必须转换为 OpenCode 官方 `POST /session?directory=/app/{scene}`，且不得向 OpenCode 透传 `scene` 字段。
- OpenCode 项目级配置由 OpenCode 进程启动时加载；如果 `{runtime.workdir}/{userId}/AGENTS.md`、`{runtime.workdir}/{userId}/.opencode` 或 `runtime.scenes` 对应的 ConfigMap、Secret、volumeMount 更新，必须重启 Runtime 容器 / Pod 才能生效。
- 查询 Runtime 状态时，应综合 Deployment、Service、Pod readiness 得出服务状态。
- 创建 Runtime 前，应通过 Kubernetes Server API 检查 Node 可用性、资源余量、Namespace ResourceQuota、LimitRange、现有 Runtime 分布、Pod readiness 和异常 Event / Condition。
- 调度控制层负责 cluster / namespace 级均衡，不直接替代 Kubernetes Scheduler 的节点调度职责。
- 架构演进优先通过扩展 Kubernetes 集群和 Namespace 分摊 Runtime 工作负载，不改变已确认的用户 Runtime、NAS 挂载、scene 转换和 Agent API 代理逻辑。
- 避免单集群 Runtime Deployment 数量持续膨胀导致 Kubernetes Server API 负载过高；当单集群控制面压力上升时，通过新增可调度集群、调整集群权重或扩展 Namespace 容量解决。
- 关闭 Runtime 时，应回收 Deployment 与 Service，避免遗留孤儿资源。
- Redis TTL 到期或触发调度删除实例时，必须删除对应 Deployment（1 副本）+ Service，并清理 Redis 映射。
- Redis 是 Runtime 状态、资源映射和租约 TTL 的权威存储。
- 创建、查询、关闭以及内部续约必须通过 Redis 做幂等或一致性控制。
- 普通代理请求触发 Runtime 租约续约到 1 小时；SSE 长连接存在时周期性续约；连接结束后停止续约，后续由 Redis TTL 到期触发回收。
- Redis 和 `config.yaml` 中不得保存 kubeconfig、Token、证书、明文密钥或完整请求体。
- 测试中不得访问真实 Kubernetes 集群或真实 Redis，应使用 fake adapter、mock client 或 fake store。

## 4. 不能做什么

- 不能把 Runtime 直接实现为裸 Pod 管理。
- 不能只创建 Deployment 而不创建 Service。
- 不能把 Deployment 副本数默认为大于 1。
- 不能让代理直接依赖 Pod IP。
- 不能绕过用户归属关系直接按任意 runtimeId 代理访问。
- 不能把不同用户的 NAS 存储路径或 OpenCode 项目级配置挂载混用。
- 不能在请求路径中执行 `kubectl`。
- 不能提交 kubeconfig、Token、证书、`.env` 或真实集群地址。
- 不能把完整平台控制面、业务 scene 编排、运行时动态配置切换、审计中心职责塞进本服务。
- 不能绕过测试声称功能完成。

## 5. 验证门禁

代码变更后必须运行：

```bash
bun test
bun run typecheck
```

若涉及 Kubernetes adapter、Runtime 生命周期、Agent API 代理，必须补充对应单元测试或接口测试。
