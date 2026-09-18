---
"@elinpf/dsh-ops-tool-trace": patch
---

修复 trace 提醒自动注入失效: dsh ≥0.1.2 移除了 `session.events` getter(改为 `snapshotEvents()`),而 `buildReminderContext` 仍读旧 getter,拿到 `undefined` 后每次 pre-step 都返回 null——`trace:idle` / `trace:stale-step` / `trace:nesting` 三条提醒全部静默失效。新增 `session-log.ts` 作为跨版本读取接缝(优先 `snapshotEvents()`,回退旧 `events`),提醒上下文构建与 `currentTurn` 统一走它。顺带修复同一根因下 `currentTurn` 恒为 0 导致节点 `turns` 记录错误、stale-step 提醒无法判定的问题。
