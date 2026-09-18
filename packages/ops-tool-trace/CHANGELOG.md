# @elinpf/dsh-ops-tool-trace

## 0.4.1

### Patch Changes

- 66a49cb: 修复 trace 提醒自动注入失效: dsh ≥0.1.2 移除了 `session.events` getter(改为 `snapshotEvents()`),而 `buildReminderContext` 仍读旧 getter,拿到 `undefined` 后每次 pre-step 都返回 null——`trace:idle` / `trace:stale-step` / `trace:nesting` 三条提醒全部静默失效。新增 `session-log.ts` 作为跨版本读取接缝(优先 `snapshotEvents()`,回退旧 `events`),提醒上下文构建与 `currentTurn` 统一走它。顺带修复同一根因下 `currentTurn` 恒为 0 导致节点 `turns` 记录错误、stale-step 提醒无法判定的问题。
- @elinpf/dsh-ops-prompts@0.4.1

## 0.4.0

### Patch Changes

- 1015b6b: 新包 `@elinpf/dsh-ops-knowledge` — 排错知识库插件: `knowledge_search` / `knowledge_record` / `knowledge_hit` 三个模型工具(access hub `/cases` 后端), 经 ops-prompts 注册静态 methodology(先搜后沉淀、采用计数纪律) + 每会话一次的病例索引 reminder(按 hitCount 取 top 10)。病例除结论(症状/根因/修复)外还有可选 methodology(排查方法论: 关键判别步骤) 和 difficulty(1-5 难度自评) 字段; `knowledge_search` 支持 query="*" 浏览全量。无 hub 配置时整体 no-op; hub 不可达时工具返回错误结果而非抛出。trace 的 doctrine HELP_TEXT 新增「收口后的知识沉淀」段, ops 部署包的 preset 带上 `tool-ops-knowledge` 行(无 config, 走 `ACCESS_HUB_URL`/`ACCESS_HUB_READ_TOKEN` 环境变量)。
- @elinpf/dsh-ops-prompts@0.4.0

## 0.3.0

### Patch Changes

- @elinpf/dsh-ops-prompts@0.3.0

## 0.2.1

### Patch Changes

- @elinpf/dsh-ops-prompts@0.2.1

## 0.2.0

### Minor Changes

- bf99896: Session-hardening batch from a real 25-hour incident review (2026-09-10 jumpserver/ceph/IB session log):
  
  - **kubectl/ceph: shell composition rejected.** The `command` arg is concatenated after the tool's binary prefix, so `;`/`&&`/`||`/backticks/`$()`/newlines used to start a NEW local command without prefix or credentials, surfacing as a misleading `get: command not found` (hit 8+ times across 7 turns). Now rejected before execution with a teaching error; a single `|` pipe (local output filter) stays allowed. Both tools also gain an optional `timeoutSec` parameter (1–600s) for known-slow commands (`rados ls` on large pools hit the fixed 30s ceiling).
  - **Profile-name idempotency.** `opsAccess.resolve`/`canResolve` tolerate a redundant `kind/` prefix (`resolve('ssh', 'ssh/b200-02')` now works) — agents routinely pass the recall token whole.
  - **Provider-declared `knownLimits`.** Mention recall and `list_access help` now carry the kind's known ro-tier boundaries: k8s documents the view-ClusterRole blindspots (nodes/PVs/storageclasses/volumeattachments/Secrets → Forbidden), ceph the ro caps boundary (tell/fs-subvolume/rbd-management → EACCES). The agent learns the credential boundary from the text, not from a 403 it re-hits after every compaction.
  - **gate: realistic TTL options.** Default `grantTtlOptions` becomes `[10, 30, 60, 120]` — with `[5, 10, 30]` every 60/120-min request was clamped to 30, forcing repeat full approvals mid-incident. The tool description now steers toward the smallest sufficient lifetime and names the panel options; an unanswered request's timeout message now tells the agent to ping the user (panel `/access-all`) instead of failing silently.
  - **trace: stale-step reminder + honest force.** New `trace:stale-step` reminder nudges when open steps (pending/in_progress) have gone 4+ turns (configurable via `staleStepReminderTurns`) without a decision — the second-half rot the idle rule cannot see (dead ends unrecorded until the user asked twice). A force-resolve WARN now names the undecided nodes it shelved and states the closure is an UNVERIFIED assertion; the `force` param doc restricts it to abandoning an investigation.
  - **ops-prompts: new `ib-rdma` skill.** The IB/RDMA investigation methodology an agent improvised mid-incident, distilled: per-port fabric enumeration (one host, several fabrics), SM liveness via activity-count growth, "SM unreachable ≠ data-plane blackhole" (VL15 vs VL0 discriminator), directed-route topology crawl without SM, and error/flap counters (`ibqueryerrors`, `carrier_changes`) as hypothesis executioners.

### Patch Changes

- Updated dependencies [bf99896]
  - @elinpf/dsh-ops-prompts@0.2.0

## 0.1.7

### Patch Changes

- e004cd5: Fix the trace panel never appearing under dsh ≥0.1.1: the session-projection contract changed (`stateSchema` + `wire.{viewSchema,view}`, wire-less units silently dropped from baselines and push frames), and `traceProjection` still carried only the ≤0.1.0-rc.8 shape (`schema` + top-level `view`). The definition now carries both shapes, so the `trace` projection is wire-visible on both contracts; peer range widened to `^0.1.0-rc.8 || ^0.1.1-rc.1`. No state-format change (`stateVersion` stays 5).
- @elinpf/dsh-ops-prompts@0.1.7

## 0.1.6

### Patch Changes

- @elinpf/dsh-ops-prompts@0.1.6

## 0.1.5

### Patch Changes

- @elinpf/dsh-ops-prompts@0.1.5

## 0.1.4

### Patch Changes

- @elinpf/dsh-ops-prompts@0.1.4

## 0.1.3

### Patch Changes

- @elinpf/dsh-ops-prompts@0.1.3

## 0.1.2

### Patch Changes

- ad9ff60: Fixed the npm tarball missing four runtime modules (`doctrine.js`, `node-status.js`, `reminders.js`, `session-forests.js`): the `files` field enumerated only four of the seven compiled outputs, so the published package could not be imported when installed from the registry. The field now ships the whole `lib/` directory.
- @elinpf/dsh-ops-prompts@0.1.2

## 0.1.1

### Patch Changes

- @elinpf/dsh-ops-prompts@0.1.1
