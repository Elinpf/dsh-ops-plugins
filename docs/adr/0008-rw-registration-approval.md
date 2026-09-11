# ADR-0008: rw 注册申请审批流(agent 提交 → 人工批准 → 落库)

- 状态:已接受(已实现 — hub 申请队列 + core 工具/代理路由 + UI 审批区块,单测全绿)
- 日期:2026-09-09
- 背景会话:feat/access-hub 线上的 rw 注册痛点讨论;承接 ADR-0005(hub 平台)与 ADR-0001(rw 人工管理的纪律)

## 上下文

ADR-0001 起rw tier 的纪律是「只能人来注册」(admin UI / yaml 手改),agent 的 `register_access` 工具只写 ro。实践中这产生了真痛点:agent 在现场(比如排障时)拿到了 rw 凭证材料——从运维同学贴的 key、从 rw 派生时的副产物——却必须中断流程等人手动进 UI 粘贴注册。

但直接把 rw 写权限放给 agent 会破坏权限模型的支柱:rw 的**使用**走 gate 人工审批,如果 agent 能自己**注册** rw,审批就形同虚设(先自注册一个 rw,再申请 grant)。威胁模型是防犯蠢不防作恶——犯蠢面包括 agent 写错字段把好用的 rw 覆盖成坏的。

## 决策

### 1. 申请队列放 hub,不放 dsh 侧

hub 是集中凭证平台(ADR-0005),多 dsh 实例共享;dsh 侧内存队列会随重启丢失且每实例各一份。hub 有加密存储(申请里的私钥/kubeconfig 随文档整体 AES-256-GCM 落盘)和审计日志,天然是申请的家。yaml 模式不支持 rw 申请——没有人可批的远端,工具直接报错指引走 admin UI。

### 2. 审批界面放 dsh 凭证管理设置区,不放 hub 自带 UI

管理员日常在 dsh 面板的「凭证管理」设置区工作;core 加三个代理路由(`GET /ops-access/admin/requests`、`GET .../detail`、`POST .../decide`)转发 hub 数据,浏览器不需要 hub 的 admin token。**审批前必须能看到字段内容**——盲批等于没批——所以 detail 路由是这套 UI 里唯一渲染秘密字段值的地方(对照:普通编辑表单里文件字段保存后只读不可见)。

### 3. 决定后即擦除申请里的 fields

批准:字段写入条目;拒绝:字段无处可去。两种情况下申请记录里的 `fields` 都立即清空,只留元数据供审计追溯。秘密不在已决定的记录里滞留。

### 4. 提交前完整校验,不把人当校验器

agent 提交 rw 申请时走与真实写入完全相同的校验:文件字段暂存(0600,随后回滚删除)→ provider 的 `validateContent` 钩子(如 ssh-keygen 验钥)→ zod schema。校验失败直接返回给 agent 修正,不进入队列——管理员看到的每个申请都是「写得进去」的。

### 5. 不阻塞 agent 的工具调用

与 gate 的 rw **使用**审批(request_access 原地停车等决定)不同,注册申请**立即返回** request id,agent 被告知「转告运维去审批」。注册不是秒级交互操作,park 一个工具调用等人工没有意义。

## 后果

- hub API 新增 `/requests` 族(POST 提交 / GET 列表+详情 / POST decide),审计动作扩展 `request/approve/reject`。
- `register_access` 工具加 `tier`(默认 ro)与 `reason` 参数;ro 路径行为不变。
- 批准写入的 tier 不带 probe 状态(probe 是 core/provider 职责,在下一次写入时补上)。
- 明确不做:申请过期清理(低频无膨胀)、agent 侧撤回接口、hub 自带 UI 的审批界面。
