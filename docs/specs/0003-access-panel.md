---
title: 授权面板（/access + 自建审批通道）— 人的主动授权/撤销入口与可调档审批
status: implemented
date: 2026-08-27
adr: docs/adr/0004-access-panel.md
---

# 授权面板（Access Panel）Spec

## Problem Statement

审计门（ADR-0001/spec 0001）落地后，授权面只有 agent 发起的 `request_access` 一个入口，人通过 dsh 原生 approval 弹窗一次性批准。三个痛点：（1）人不能**主动**授权——知道接下来要干写操作，也得等 agent 开口再点弹窗；（2）审批**粒度太粗**——agent 要 60 分钟，弹窗只有给/拒，人不能改成 10 分钟；（3）人没有**撤销入口**——只有 agent 自己能撤自己会话的 grant。原生 approval 通道的结果词汇封闭（四态，不能携带修改后的参数），answerer 注册顺序无优先级保证，撑不起这些需求。

## Solution

一个会话作用域的自建对话框（授权面板），两个入口模式：空闲时是人的主动授权/撤销面板，有待决请求时是审批台。gate 自建**待决请求通道**替代 `ctx.approval`：agent 的提权申请驻留在进程内队列，人通过面板的 HTTP 路由裁决（可调整 TTL 档位），裁决解出驻留的工具 Promise。授权与撤销都会往目标 session 注入 model-visible 通知消息，agent 对称感知。

grant 模型本身不动：面板授权与申请批准的 grant 同构（按 session 分键、TTL 有界、重启清空），面板只是跳过"agent 开口"这一步。

## User Stories

1. 作为运维，我希望在会话里敲 `/access` 打开授权面板，看到可授权档案列表，选中档案后选 TTL 档位（5/10/30 分钟）再确认，这样我能在 agent 开口前就放行 rw。
2. 作为运维，我希望面板里看到本会话当前活跃的 grant（档案、剩余时间、来源），这样我知道这个会话现在握着什么。
3. 作为运维，我希望点活跃 grant 条目（带确认）即撤销，这样发现 agent 行为不对劲时能立刻收回。
4. 作为运维，我希望有「收回本会话全部授权」一键清场（带确认），这样紧急时不用逐条点。
5. 作为运维，我希望 agent 申请提权时审批对话框自动弹出，显示档案、agent 自述的理由、请求的 TTL，并且 TTL 是一个可拨的档位选择器（默认停在请求值），这样我能"批，但只给 10 分钟"。
6. 作为运维，我希望审批可以拒绝，agent 拿到的工具结果明确说明被拒，这样它能换思路而不是死等。
7. 作为 agent，我希望面板授权/撤销后我立刻收到一条通知消息，这样我不会按过时的权限假设继续规划。
8. 作为 agent，我希望审批结果告知我**实际**批准的 TTL（含"人调整了档位"的事实），这样我能按真实时间窗安排工作。
9. 作为 agent，我希望我申请的授权 5 分钟没人理就自动被拒，这样我不会无限挂起。
10. 作为运维，我希望 headless 部署（无 web 端）里 request_access 立即报"无审批通道"并给带外指引，这样失败快速且明确。
11. 作为审计员，我希望申请、面板授权、撤销（含来源区分）、超时拒绝都落 audit.log，这样授权史完整可重建。
12. 作为运维，我希望面板只在 ops preset 的会话里出现（/access 只在有 gate 的组合里注册），这样别的预设不受打扰。

## Implementation Decisions

### 涉及的包和角色

- **ops-panel**（**新建**，host 平面薄壳 + client bundle）— 面板缝：client 半 `ctx.provide('opsPanels', ...)` 提供 `registerPanel({ command, title, available?, component }): Disposer` 注册服务，内部是单一 `command/executed` 监听 + 按命令名分发 + overlay 外壳组件（标题栏/Escape/背景关闭/主题变量/每会话开关状态，注册进 `conversation.input.overlay`）；node 半只出无状态 helper `registerPanelCommand(ctx, { name, description })`（注册空 handler 的 host 命令）和词汇类型。无 Config。做服务不做纯库——纯库会被各消费方 bundle 各打包一份，注册表/监听/外壳互撞（双模块实例教训）。先例：dsh 的 ui-commands（`ctx.commandUi`），本包是它的"完整对话框"档。
- **ops-access/gate**（preset 平面）— 待决请求队列、人侧 HTTP 路由、对称通知注入、新增 Config。`/access` 命令经 `registerPanelCommand` 注册。request_access 的 request 动作改为走待决队列。
- **ops-access-ui**（host 平面薄壳 + client bundle）— 降为**纯消费方**：client 半 `inject: ['opsPanels']`，调 `registerPanel` 注册授权面板内容组件（两步选择 + 撤销列表 + 审批视图）+ 待决请求轮询。host 行仍只为 bundle 发现存在。

### /access 命令与面板触发

- gate 用 ops-panel 的 `registerPanelCommand(ctx, { name: 'access', description })` 注册 host 命令：无输入（bare invocation），handler 返回成功（可带一句"面板已打开"的 UI text），`recordInput` 默认即可。命令生命周期（command/run|done）log-only 落 session 日志，不进模型历史。
- 面板的打开链路归 ops-panel：它的 client 半持有**单一** `command/executed` 监听（dsh 文档 sanction 的"浏览器专属副作用"通道，只有敲命令的那个浏览器会收到），按命令名分发到 `registerPanel` 注册的面板，打开 overlay 外壳并渲染该面板的内容组件。消费方不碰事件监听。
- **不复用** ui-commands 的 popupSelect（单层契约装不下两步选择，见 ADR-0004 决策 1），overlay 外壳由 ops-panel 实现，注册进 `conversation.input.overlay` 槽位（popupSelect 同槽；同槽多注册有 todo/trace 双 dock 先例），实现时按 ui-conversation 的 SlotMap 现状校准。

### 待决请求通道（替代 ctx.approval）

```
interface PendingRequest {
  id: string            // gate 生成
  session: string       // exec.agent.id
  kind: string
  name: string
  requestedTtlMinutes: number
  reason: string
  createdAt: number
  decidesAt: number     // createdAt + pendingRequestTimeout
}
```

生命周期：request_access 的 request 动作做完可交付性预检（现有 canResolve 机器不动）后 → 入队 + 落 `grant-request` 审计行 → Promise 驻留。三个解出路径：

- **裁决**：路由收到 decide（approved + 人选择的 ttlMinutes / rejected）→ 写账本（批准时）+ 审计 → resolve。批准后工具结果文案含实际 TTL 与"档位被调整"的事实。
- **超时**：清扫器（或惰性检查，同账本 expire 的惰性纪律）发现过 decidesAt → 自动拒 + 审计。
- **中止**：exec.signal abort → `cancelled`，不写账本，审计落行。

headless 判别：apply 时 `ctx.get('webServer')` 缺失则人侧路由不注册；request_access 检测到路由未注册（模块内标志位）→ 立即返回"无审批通道（headless 部署），请运维带外授权"，不入队。

### 人侧 HTTP 路由（preset 平面注册进 host webServer，同 GET /ops-access/list 的位置与纪律）

- `GET /ops-access/grants?session=<id>` — 该会话活跃 grant 列表（kind/name/expiresAt/reason/approvedBy + 剩余分钟）
- `POST /ops-access/grants` — body `{session, kind, name, ttlMinutes}`：面板授权。ttlMinutes 必须命中 Config 档位（否则 400）。写账本 + 审计（approvedBy: 'panel'）+ 注入 `<access-grant>` 通知
- `POST /ops-access/grants/revoke` — body `{session, kind, name}`：撤一条。审计（来源 panel）+ 注入 `<access-revoked>` 通知
- `POST /ops-access/grants/revoke-all` — body `{session}`：清空该会话账本。每条落 revoke 审计行 + 一条汇总通知
- `GET /ops-access/access-requests?session=<id>` — 该会话待决请求（client 轮询用，间隔 ~3s，仅面板所在会话活跃时轮）
- `POST /ops-access/access-requests/decide` — body `{id, approved, ttlMinutes?}`：裁决待决请求。approved 时 ttlMinutes 必填且命中档位

可授权档案列表复用现有 `GET /ops-access/list`（envelope-only + ro/rw 就绪标记，已够面板渲染）。ssh 档案走同一面板：它的"授权"语义是限时放行使用，档位同样适用（对应现有 approvalRequiredKinds 逻辑，broker 不动）。

### 对称通知注入

路由写账本/撤账本后，往目标 session 追加一条 model-visible 消息：`<access-grant>operator 授予 k8s/<id> rw 权限，至 14:35（10 分钟）</access-grant>` / `<access-revoked>…已被运维收回，本会话回落只读</access-revoked>`。机制沿用 mention 注入验证过的路子（preset 平面插件向 session 追加消息）；**实现时若现有缝不支持主动追加，降级为面板提示"已授权，请在会话里告知 agent"并在 spec 记录此偏差**——通知是体验优化，不挡授权主链路。

### Config 新增（gate）

- `grantTtlOptions: number[]`（默认 `[5, 10, 30]`）— TTL 档位，主动授权与审批共用
- `pendingRequestTimeoutMinutes: number`（默认 `5`）— 待决请求超时

defaultTtlMinutes/maxTtlMinutes 保留：default 是 agent 不指定时的请求值，max 仍是 agent 可请求的上限；人裁决时不受 max 约束但受档位约束。

### 审计事件扩展

AuditEvent 的 event 联合增加 `'grant-request'`（含 requestedTtlMinutes/reason）与 `'request-decide'`（含 approved/实际 ttl/来源）。面板授权的 grant 行 approvedBy 记 `'panel'`；申请批准的记 `'user'`（现状）。revoke 行增加来源字段（panel / agent-self）。`ledger-reset` 同时清空待决队列（驻留 Promise 全部以 cancelled 解出）并各落一行。

### request_access 工具变更

- request 动作：删掉 `ctx.approval` 调用，改为入队待决。工具描述更新（"人可调整 TTL"）。list/revoke 动作不变。
- 可交付性预检（canResolve 两处分支）原样保留。
- 结果文案：批准 → `Granted k8s/<id> until …（10 分钟，运维把请求的 60 分钟调整为 10 分钟）`；拒绝/超时/中止各有明确文案。

## Non-Goals

- **常驻策略**（信任环境长期放行 rw）——绕开一次性批准原则，需独立威胁模型讨论（ADR-0004 缓议项）
- **封禁**（连 ro 都锁的第四态）——等面板落地后看真需求
- **跨会话总览与撤销**——面板是会话作用域 UI；跨会话视图是另一个 surface
- **撤销即掐断进行中命令**——撤销从下一次解析生效，不动命令生命周期
- **自由 TTL 输入**——只有档位
- **grant 持久化**——重启/HMR 清空账本的语义不变

## Test Plan

- ops-panel 单测：registerPanel/disposer（HMR 卸载即移除）、command/executed 按名分发（未注册命令名忽略）、外壳开关状态每会话隔离
- gate 单测：待决队列（批准/拒绝/超时/abort/重复裁决幂等）、TTL 档位校验（档位外 400）、headless 快速失败、revoke-all 逐条审计、ledger-reset 解出全部驻留 Promise、request_access 结果文案（含档位调整说明）、registerPanelCommand 注册的命令可执行且 log-only
- 路由测试沿用现有 admin 路由的测试姿势（轻量 HTTP 层或直接调 handler，按现有测试基建现状）
- ops-access-ui client 测试：面板状态机（空闲两步流/审批流/撤销确认）、command/executed 过滤、轮询启停
- 真实验证：`.dsh-target`（3082）开 session，`/access` 开面板授权 → agent 调用拿 rw → 面板撤销 → agent 收到收回通知 → request_access 走通审批弹窗调档
