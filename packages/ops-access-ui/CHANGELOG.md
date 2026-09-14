# @elinpf/dsh-ops-access-ui

## 0.2.0

### Minor Changes

- b8bb955: Agent-submitted rw registration requests with human approval (ADR-0008). The `register_access` tool gains `tier: "rw"` and `reason` parameters: instead of writing (rw stays human-approved), it validates the fields exactly like a real write (provider content hooks + zod schema) and queues a registration request on the hub (hub mode only; yaml mode fails with guidance). The admin settings section (凭证管理) gains a "待审批注册申请" block listing pending requests; reviewing one shows the full field contents (the only place secrets render in this UI — seeing the material is the point of approval), and approving writes the tier via new core proxy routes (`/ops-access/admin/requests`, `/detail`, `/decide`) so the browser never holds the hub token.

### Patch Changes

- a06f6d8: 适配 dsh 0.1.5 的 input-dock 槽位契约：sessionId 改由槽位条目的 `inject(sessionId)` 面提供（zone props 不再携带），待审批计数不再读 `runningCalls` 快照（新版快照已不含此字段），统一轮询 gate 的 `/ops-access/access-requests`（该路由本就同时返回本会话与委派子会话的请求）。修复升级 0.1.5 后提权申请小红点不渲染的问题。

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.1.1
