# ADR-0005: access-hub —— 集中凭证平台与 core 双后端

- 状态：已接受（已实现 — hub 服务包与 core HubBackend 均已落地，单测全绿；yaml 来源 125 个原测试未改动通过）
- 日期：2026-09-04
- 背景会话：access-hub 特性规划（票见 `.scratch/access-hub/issues/`）；前身是 ADR-0001 决策 8 的"二期中心服务"

## 上下文

凭证体系自 ADR-0001 起以本地 YAML 注册表为唯一事实源：秘密从不落进任何服务，profile 只携路径。这在单机上成立，但凭证分散在每个 dsh 宿主的 `access.yaml` + credentials 目录里：多机部署要逐台同步文件，轮换凭证要逐台改，也没有一个"现在登记了哪些凭证、谁在用"的集中视图。ADR-0001 决策 8 早已预留方向——中心服务作为 remote 后端挂在 provider 缝后面。本 ADR 把它落地，并按实现修正决策 8 的两个预设（见决策 4）。

## 决策

### 1. 自建轻量服务，不引 Vault/OpenBao

否决了直接接 Vault 类系统：它们引入一整套部署、认证、策略概念，建设成本高一个数量级，且与本体系的 tier 模型（ro/rw 条目、envelope、probe）对不齐——映射层我们自己写，复杂度一分不少。自建服务只实现我们需要的最小面：加密存储、双 token 认证、REST API、审计。依赖底线是 `yaml` 一个包，HTTP 用裸 `node:http`，无框架。

### 2. 运行时按需直取，不做同步/缓存

否决了"hub 定期下发快照到各机"的方案（快照又是一份静态秘密拷贝，且失效语义复杂）。core 的 `HubBackend` 每次调用都打 hub——与 yaml 后端"现读现校验不缓存"是同一条纪律，改 hub 立即生效，无一致性问题要处理。代价是每次 resolve 一次 HTTP 往返，在 loopback/内网尺度下可忽略。

### 3. API + 简单 Web UI，不做独立管理端应用

hub 暴露一个小 REST API（entries CRUD + audit），并自带一个单文件中文 Web UI（`GET /`，内联 vanilla JS，无构建链）：token 输入存浏览器 localStorage，条目列表/新建/编辑/删除、probe 徽标、审计查看。UI 是无鉴权的静态壳——它本身不含任何秘密，所有数据请求都带 token。不做独立前端工程。

### 4. 放 monorepo 新包，作为仓库唯一的"非插件"例外

hub 不是 dsh 插件（无 cordis.patch.yml、不进 preset、package.json 无 `dsh` 字段），但放进本 monorepo 而非另立仓库：词汇、数据模型、测试纪律与 ops-access 同源，分开维护只会漂移。代价由例外规则吸收：不进 changesets fixed 组，独立版本节奏（首发 0.1.0）。

**对 ADR-0001 决策 8 的修正**：决策 8 设想"只上收 rw、ro 留本地保可用性 + break-glass 本地钥匙"。实现选择了更简单的形态——hub 是全量来源（ro/rw 都存 hub），`source: 'yaml'|'hub'` 是整库切换而非按 tier 拆分：yaml 来源本身就是随时可切回的 break-glass（本地 `access.yaml` + credentials 目录不动即可回退），无需单独维护应急钥匙机制。挂载点也从"provider 缝后换实现"修正为 core 内部的 `AccessBackend` 缝（provider 仍只管 schema/字段加工，来源抽象不该穿透到它）。

## 架构分工

- **hub 是哑存储**：不做 kind schema 校验，不认识 k8s/ceph/ssh。fileField 直接存**内容**而非路径——hub 的世界只有 kind/name/tier/fields/envelope/probe。
- **schema 权威留在 provider**：core 从 hub 取回 fields 后，物化（见下）→ 照旧过 provider zod schema + process + validateContent。hub 存了非法条目，炸在 access 侧校验，与 yaml 来源同位置。
- **probe 留在 access 侧**：能力探针需要 provider 机器与真实基础设施，hub 只存算好的结果（tier 旁的 `probe` 键，随 PUT 回写）。
- **gate 不变**：broker、授权账本、register_access、admin 路由、probe 流程对两种来源透明——它们操作的是 core 的服务面，不知道来源是 yaml 还是 hub。
- **物化（materialize）**：hub 存内容、CLI 要文件。resolve 时 core 把 fileField 内容落盘到 `credentialsDir/kind/name/tier/field`（0600、原子写、内容相同跳过），fields 值替换为该路径——下游看到的 profile 与 yaml 来源同形，路径仍不出本机。元数据读（canResolve/list/getEntry，如门批准前预检）走 `materialize: false`：只替换将然路径、不落盘。写入方向相反：putTier 把本地受管文件的内容读出上传。

## 威胁模型变化与缓解

旧模型的基石"秘密从不经过任何服务"在 hub 模式下不成立，变化与缓解逐条对应：

| 变化 | 缓解 |
|---|---|
| 秘密集中存储，hub 成单点 | AES-256-GCM 加密落盘（单一 JSON 文档，tmp+rename 原子写）；master key 独立于数据（env `ACCESS_HUB_KEY` 或 0600 key 文件）；**数据文件 + key 都要备份**——这是运维纪律，代码兜不了 |
| 秘密在传输中（resolve/写入时经 HTTP） | v1 明文 HTTP 只绑 loopback；远程部署必须套 TLS 反代（TLS 终结明确不做，见下）。token 比较用 `crypto.timingSafeEqual` |
| 认证从零变有 | 双 Bearer token：read（列表 + 解析）与 admin（写删 + 审计）分离，core 默认只配 read token、写入路径才要 admin；未配置的首启生成随机 token 打印一次。401（无/错 token）与 403（read 触管理端点）区分 |
| 物化文件是新的秘密落点 | 0600、原子写、内容相同不重写（不刷 mtime）；元数据读不落盘；目录与 yaml 模式共用 credentialsDir，同一套纪律 |
| 集中后的操作可见性需求 | append-only JSONL 审计（resolve/put/delete，含 token 角色，**永不记字段值**）；`GET /audit` 仅 admin |
| token 泄露面 | token 不进日志、不进错误消息；core Config 的 token 字段有 env 回退，可不落配置文件 |

威胁模型基调不变：仍是 ADR-0001 的"防犯傻，不防主动作恶"——同机同 UID 的攻击者从来就能读本机凭证文件，hub 不改变这个边界。

## 被否决方案汇总

| 方案 | 否决原因 |
|---|---|
| Vault / OpenBao | 建设与运维成本高一个数量级；tier/envelope/probe 模型对不齐，映射层照样自己写 |
| 加密 sqlite / 数据库 | 单一 JSON 文档足够（条目量级是几十）；引入数据库引擎只为查询能力，我们不需要 |
| hub 定期下发快照 | 快照是又一份静态秘密拷贝；失效与一致性语义复杂，按需直取根本没有这个问题 |
| 按 tier 拆分来源（ro 本地、rw 上收，ADR-0001 决策 8 原案） | 双来源并存 = 两套读取纪律同时维护；整库切换 + yaml 随时可回退已覆盖 break-glass 需求 |
| 来源抽象穿透到 provider 缝 | provider 职责是 schema/字段加工；让它知道 HTTP 来源是职责越界，backend 缝在 core 内部即可 |
| hub 内嵌 TLS | 证书管理是部署题不是代码题；loopback 默认 + 反代文档指引覆盖真实需求 |
| 多用户 / RBAC | 双 token 已覆盖"消费方只读、管理员可写"的全部现实角色；用户体系是另一个数量级 |
| 短期凭证签发（hub 动态派生 ro 账号） | 派生留在 agent 侧的 register_access 流程（provider derivationDoc），hub 只做存储 |

## 明确不做

- TLS 终结（文档指引套反代）
- 多用户 / RBAC
- 短期凭证签发
- HA / 集群（单实例 + 备份）

## 后果

- 新增包 `packages/ops-access-hub`（独立版本，首发 0.1.0）；core 新增内部 `AccessBackend` 缝与 `HubBackend`，`YamlBackend` 收编原逻辑行为逐字节不变。
- core Config 新增 `source` / `hubUrl` / `hubToken` / `hubAdminToken`（全部可选，默认行为不变）。
- 迁移路径：`dsh-ops-access-hub import <access.yaml>` 把路径形态字段替换为文件内容后入库，在线（`--url`）或离线（`--data-dir`）。
- 已知接受的风险：hub 单点故障即全来源不可用（yaml 回退是人工切配置）；明文 HTTP 部署暴露在内网时需操作员自觉套反代。
