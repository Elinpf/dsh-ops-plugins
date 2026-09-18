# ADR-0009: 具名 token —— 按人分发、单独吊销、审计归属

- 状态:已接受(已实现 — hub 名册/API/CLI/UI 全部落地,单测全绿;静态 token 行为不变)
- 后续:`docs/adr/0010-token-admin.md` 在本文的管理面上补"就地编辑 + 状态四分 + 名册筛选"(`PATCH /tokens/:id`、CLI `token update`);本文的边界(两种角色、不做用户体系/RBAC、吊销终态)全部不变
- 日期:2026-09-17
- 背景会话:任务看板 `t-mu5bphyz-77gnvj`「access-hub 中新增对 token 的区分」;修订 ADR-0005「明确不做 — 多用户/RBAC」的边界

## 上下文

ADR-0005 给 hub 的是**两把共享钥匙**:admin 与 read,只能从 CLI flag / env 注入。单消费者 + 单管理员的场景够用,多人协作时直接卡住:

- 没法给「小李只读」「小王管理员」发不同凭证——人人共享同一把 key;
- 想收回一个人的访问权只能整体换 token,等于让所有人重新配置一次;
- 审计行只有 role,出事无法回答「是谁解析了这把 kubeconfig」;
- 无法给临时/外包人员设有效期。

## 决策

### 1. 具名 token 是 hub 的一等公民

一条 token 记录 = `name`(持有人标签,审计里的 `actor`)+ `role`(admin/read,与既有语义同源)+ 可选 `expiresAt`。随整篇文档 AES-256-GCM 加密落在 `<data-dir>/hub-data.json.enc` 的新 `tokens` 段。`name` 在**未吊销**的记录里唯一(前一个持有人走了,标签可复用)。

### 2. 只存摘要:明文只在签发响应里出现一次

落库的只有 `sha256` hex 摘要 + 明文前 8 字符前缀(列表辨识用,和吊销按钮并排)。明文由 `POST /tokens` 返回一次,Web UI 高亮展示、CLI 打印一次,没有找回途径——丢了就吊销重建。

否决「明文入库以便重复展示」:文档虽然加密,但备份、master key 泄露、运维随手查看都是现实路径;摘要化把「拿到数据文件」与「拿到可用凭证」解耦。

### 3. 角色仍是两种,不做细粒度 RBAC

需求是「按人区分 + 能单独收回」,不是权限模型升级。`role` 沿用既有 admin/read(含 cases 只读角色可写的刻意放宽)。按 kind/tier 的细粒度授权属于 access gate 的 grant 账本(ADR-0001),不是 hub 认证层的事。

### 4. 吊销是终态,且立即生效

`DELETE /tokens/:id` 置 `revokedAt` 后:该 token 立刻 401(错误消息区分「token revoked or expired」),记录保留在名册里供审计追溯,不可恢复。恢复访问 = 新建一条。

### 5. 归属进审计:审计行新增可选 `actor`

具名 token 的每次成功操作在 `audit.log` 里带上 `actor = name`,于是「谁 resolve 了什么」可回答。**静态 bootstrap token 不写 actor**:它们是共享凭据,写 role 已足够,写一个像实名的标签反而是假归属。

### 6. 静态 env/flag token 保留为 bootstrap / break-glass

静态 admin/read token 始终有效,且**不可通过 API 吊销**。理由:单点锁死是真实运维风险(把所有具名 admin token 都吊销了就再也进不去 hub);轮换静态 token 仍走 env + 重启。这是刻意的向后兼容,不是遗留 bug——core / gate 的既有配置(`ACCESS_HUB_READ_TOKEN`)一字不改继续工作。

### 7. 有效期可选

`expiresAt` 只收未来时间(签发时即过期是调用错误,400);到期与吊销走同一条 401 路径。给临时/外包人员设期限用。

### 8. 名册上限 MAX_TOKENS = 200

名册随整篇文档重写落盘,不设上限等于允许无界膨胀。到顶报错提示先吊销陈旧 token。

## 被否决方案

| 方案 | 否决原因 |
|---|---|
| 明文入库(可重复展示) | 数据文件 + key 一旦泄露就是全部可用凭证;摘要化后泄露的文件不直接可用 |
| 用户体系(账号/密码/登录、自助注册) | 与「按人发钥匙」不是一个数量级;需求不需要身份认证系统 |
| 细粒度 RBAC(按 kind/tier/操作授权) | 那属于 gate 的 grant 账本(ADR-0001);hub 认证层只认 admin/read |
| 多角色(owner/viewer/...) | 没有现实角色映射,先不引入概念 |
| `lastUsedAt` 使用时间戳 | 每次请求都要重写整篇加密文档(写放大 + fsync);审计已能回答「谁在用」 |
| 签发审批流(申请 → 批准) | 签发本身已是 admin 动作;再套一层审批只增加摩擦,与 ADR-0008 的 rw 字段审批不同——那条流程保护的是秘密的**写入**,这条只是分发钥匙 |

## 后果

- hub 文档新增 `tokens` 段(旧数据文件无此段,惰性创建);`POST /tokens`、`GET /tokens`、`DELETE /tokens/:id`、`GET /whoami` 四个端点;审计动作新增 `token-create` / `token-revoke`,审计行新增可选 `actor`。
- CLI 新增 `token create|list|revoke`,在线(`--url` + admin token)或离线(`--data-dir` + master key)两种落点,与 `import` 同纪律;离线签发 `createdBy` 记为 `cli`。
- Web UI 新增 token 名册区块(签发 / 一次性明文展示 / 吊销)与审计「操作者」列;Bearer token 输入框经 `/whoami` 显示当前解析出的角色与标签。
- core / gate / 消费方零改动:继续用静态 read token,或换发一个具名 read token。
- 已知接受的边界:token 泄露后到被吊销之间的窗口仍由持有者行为决定;静态 token 无法单独失效(轮换 = 改 env 重启)。
- 明确不做:用户体系/登录、细粒度 RBAC、自助注册、明文找回、`lastUsedAt`、token 轮换自动化。
