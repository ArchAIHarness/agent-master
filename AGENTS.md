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
- Agent API 默认按 OpenCode 官方接口通用透明代理转发到 Agent Service：去掉 `/agent` 前缀，保留后续路径、查询参数、HTTP 方法和请求体。
- `POST /agent/session` 不做 `scene -> directory` 转换；OpenCode 官方 `directory` query 参数由调用方显式传入并透明透传，`scene` 与接口 `directory` 没有直接关系。
- Agent API 代理路径必须以 OpenCode Server 官方 API 为准，优先查询 Agent `/doc` OpenAPI 规范或官方文档，不得自行编造 OpenCode API 路径。
- 多集群调度逻辑必须显式处理 cluster、namespace、资源名称、资源检查结果和错误返回。
- 创建 Agent 前必须通过 Kubernetes Server API 检查候选集群和 Namespace 的资源状态，用于 Agent 容器调度均衡。
- Agent 实例映射、启停状态、租约续约、TTL 回收必须使用 Redis。
- Agent Redis Key 固定为 `agent-runtime:user:{userId}`，Agent 状态不得把 OpenCode `directory` 或任何业务场景作为实例归属条件。
- Agent 实例归属以用户为基本单位。
- `runtime.workdir` 是用户 NAS 工作目录根路径；Kubernetes 启动 Agent 时必须将 `{runtime.workdir}/{userId}` 挂载到容器内 `/app`。覆盖镜像内 `/app` 是预期行为。
- 用户默认项目规则必须直接位于 `{runtime.workdir}/{userId}/AGENTS.md`，通过 `{runtime.workdir}/{userId} -> /app` 根挂载自然成为容器内 `/app/AGENTS.md`。
- 用户默认项目级 OpenCode 配置必须直接位于 `{runtime.workdir}/{userId}/.opencode`，通过 `{runtime.workdir}/{userId} -> /app` 根挂载自然成为容器内 `/app/.opencode`。
- OpenCode 用户级运行配置必须按用户持久化：`{runtime.workdir}/{userId}/.runtime/opencode/config -> /root/.config/opencode`，`{runtime.workdir}/{userId}/.runtime/opencode/share -> /root/.local/share/opencode`。
- `runtime.agentPresets` 是 Agent 预设配置包映射；`{runtime.agentPresets.<preset>}` 指向预设配置包根目录，目录内必须包含 `AGENTS.md` 和 `.opencode/`。
- Kubernetes 启动 Agent 时必须把 `runtime.agentPresets` 中声明的预设配置包源目录只读挂载到 `/agent-preset-config/{preset}`，由 initContainer 复制 `AGENTS.md` 和 `.opencode/` 到用户侧 `/app/{preset}`，避免运行容器直接用只读挂载遮蔽用户工作目录。
- Agent 创建或重启前，初始化流程必须确保所有挂载依赖路径存在：用户根目录 `{runtime.workdir}/{userId}`、用户默认 `AGENTS.md`、用户默认 `.opencode/`、OpenCode 用户级持久化目录 `.runtime/opencode/config` 与 `.runtime/opencode/share`、所有已声明 preset 的用户工作目录 `{runtime.workdir}/{userId}/{preset}/`，以及所有已声明 preset 的预设配置包源路径 `{runtime.agentPresets.<preset>}/AGENTS.md` 与 `{runtime.agentPresets.<preset>}/.opencode/`。
- 新增 `runtime.agentPresets` 时，必须先创建用户侧 preset 工作目录 `{runtime.workdir}/{userId}/{preset}/` 和预设配置包源路径 `{runtime.agentPresets.<preset>}/AGENTS.md`、`{runtime.agentPresets.<preset>}/.opencode/`；后续新建或重启的 Agent 按最新配置生成 source volume 并在 initContainer 中复制。
- `runtime.agentPresets` 预设配置包不配置 `plugins/`、`commands/`、`modes/`；`plugins/` 只放在用户默认项目级配置 `/app/.opencode` 中。
- `runtime.agentPresets` 的容器内源路径固定为 `/agent-preset-config/{preset}`；复制目标固定为 `/app/{preset}/AGENTS.md` 和 `/app/{preset}/.opencode`，用户 preset 工作目录 `/app/{preset}` 保持承载工作文件和运行产物。
- `/app/{preset}/AGENTS.md` 和 `/app/{preset}/.opencode` 是 initContainer 从 `/agent-preset-config/{preset}` 复制得到的用户侧文件，不是运行容器的直接只读挂载。
- 上述镜像、端口、环境变量、卷、挂载路径和安全约束最终必须渲染为 `deploy.yaml`，用于创建或更新 Kubernetes Agent Deployment。
- `deploy.yaml` 中的用户路径必须来自 `x-user-id` 和服务端配置拼接，不接受客户端传入任意挂载路径；不得保存 kubeconfig、Token、证书、Cookie、账号密码或明文密钥。
- 使用 subPath 或文件级映射时，源文件、源目录和目标父目录必须由初始化流程预先创建，避免 Kubernetes 因挂载目标不存在而启动失败。

## 3. 怎么做

- Agent 创建流程默认生成：
  - Agent 实例 ID。
  - Deployment 名称。
  - Service 名称。
  - Pod Labels / Selector。
- 每个 Agent 创建一个 Deployment。
- 每个 Agent Deployment 固定 `replicas = 1`。
- 每个 Agent Deployment 配套创建一个 Service。
- Deployment、Service、Pod 必须通过统一 Labels 绑定到同一个 Agent 实例。
- Agent 实例必须按用户挂载 NAS 工作目录，路径规则为 `{runtime.workdir}/{userId} -> /app`。
- Agent 启停与 OpenCode `directory` 无关；`directory` 只是 OpenCode 官方接口参数，由调用方显式传入并通过 `/agent/*` 透明透传。
- OpenCode 会话创建时不得读取请求体 `scene` 并拼接 `directory`；`agent-master` 不维护 `scene -> directory` 的映射关系。
- OpenCode 项目级配置和用户级运行配置由 OpenCode 进程启动时加载；如果 `{runtime.workdir}/{userId}/AGENTS.md`、`{runtime.workdir}/{userId}/.opencode`、`{runtime.workdir}/{userId}/.runtime/opencode/config`、`{runtime.workdir}/{userId}/.runtime/opencode/share` 或预设配置源更新，必须重启 Agent 容器 / Pod 才能生效。
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

若涉及 Kubernetes adapter、Agent 生命周期、Agent API 代理，必须补充对应单元测试或接口测试。
