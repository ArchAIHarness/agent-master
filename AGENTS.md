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
- Agent API 代理入口使用 `/api/v1/runtime/agent/*`，服务基于用户归属查找当前 Runtime，不把 `runtimeId` 作为代理入口路径参数。
- 上游完成鉴权后必须通过 `x-user-id` Header 传入用户标识，服务将其作为 `userId` 查找用户归属的 Runtime 实例，Redis Key 固定为 `agent-runtime:user:{userId}`。
- `x-user-id` 缺失或为空时，必须拒绝 Runtime 创建、查询、关闭和代理请求。
- `x-user-id` 只信任上游网关或上游服务注入，不接受公网客户端绕过上游后直接伪造。
- `Authorization` 由上游处理，本服务不自行解析用户 Token；如请求中仍携带 `Authorization`，禁止向 Runtime 透传。
- Agent API 代理必须支持 HTTP 与 SSE。
- Agent API 转发到 Runtime Service 时必须去掉 `/api/v1/runtime/agent` 前缀，保留后续路径、查询参数、HTTP 方法和请求体。
- Agent API 代理路径必须以 OpenCode Server 官方 API 为准，优先查询 Runtime `/doc` OpenAPI 规范或官方文档，不得自行编造 OpenCode API 路径。
- 多集群调度逻辑必须显式处理 cluster、namespace、资源名称、资源检查结果和错误返回。
- 创建 Runtime 前必须通过 Kubernetes Server API 检查候选集群和 Namespace 的资源状态，用于 Agent 容器调度均衡。
- Runtime 实例映射、启停状态、租约续约、TTL 回收必须使用 Redis。
- Runtime Redis Key 固定为 `agent-runtime:user:{userId}`，Runtime 状态不得把 scene 作为实例归属条件。
- Runtime 实例归属以用户为基本单位。

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
- Runtime 实例必须按用户挂载 NAS 存储根路径，路径规则为 `{nas.path}/users/{userId}`。
- Runtime 启停与 scene 无关；scene 只在 OpenCode 会话创建时使用。
- OpenCode 会话创建时必须支持根据请求体 `scene` 拼接容器内 workdir `{runtime.workdir}/{scene}`，并从 Kubernetes 挂载的场景约定配置根目录读取 `{runtime.config}/{scene}/AGENTS.md` 等约定材料；`runtime.config` 不是 OpenCode 项目级 `.opencode` 目录。
- 查询 Runtime 状态时，应综合 Deployment、Service、Pod readiness 得出服务状态。
- 创建 Runtime 前，应通过 Kubernetes Server API 检查 Node 可用性、资源余量、Namespace ResourceQuota、LimitRange、现有 Runtime 分布、Pod readiness 和异常 Event / Condition。
- 调度控制层负责 cluster / namespace 级均衡，不直接替代 Kubernetes Scheduler 的节点调度职责。
- 关闭 Runtime 时，应回收 Deployment 与 Service，避免遗留孤儿资源。
- Redis TTL 到期或触发调度删除实例时，必须删除对应 Deployment（1 副本）+ Service，并清理 Redis 映射。
- Redis 是 Runtime 状态、资源映射和租约 TTL 的权威存储。
- 创建、查询、关闭以及内部续约必须通过 Redis 做幂等或一致性控制。
- 只要 Agent API / WebUI 连接仍然存在，就必须自动将 Runtime 租约续到 1 小时。
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
- 不能把完整平台控制面、scene 配置编排、审计中心职责塞进本服务。
- 不能绕过测试声称功能完成。

## 5. 验证门禁

代码变更后必须运行：

```bash
bun test
bun run typecheck
```

若涉及 Kubernetes adapter、Runtime 生命周期、Agent API 代理，必须补充对应单元测试或接口测试。
