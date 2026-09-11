---
"@elinpf/dsh-ops-access-ui": patch
---

适配 dsh 0.1.5 的 input-dock 槽位契约：sessionId 改由槽位条目的 `inject(sessionId)` 面提供（zone props 不再携带），待审批计数不再读 `runningCalls` 快照（新版快照已不含此字段），统一轮询 gate 的 `/ops-access/access-requests`（该路由本就同时返回本会话与委派子会话的请求）。修复升级 0.1.5 后提权申请小红点不渲染的问题。
