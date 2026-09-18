# @elinpf/dsh-ops-access

## 0.4.1

## 0.4.0

### Patch Changes

- 5d1a604: access 支持每次调用显式声明凭证档位: 所有 shell 系消费工具(kubectl/ceph/ssh)和 prometheus 工具新增可选 `tier: 'ro'|'rw'` 参数。不传 = 按授权自动决定(现状); 显式 `'ro'` = 主动降级——持有 rw 授权的会话也可以用只读凭证执行纯查询, 授权不受影响也不记 rw-issue 审计; 显式 `'rw'` = 要求写档, 未授权时响亮报错并指引 request_access(不再静默给 ro)。对 approval-required 的 kind(ssh, 凭证只有一份)显式要 rw 会得到明确的"无 rw 档"教学错误。core 的 `resolve` 新增第 4 参 `AccessRequest`; 无 gate 时显式 rw 直接抛错(rw 永不在无 broker 时签发)。
- 34bc97e: 内部去重清理(code-review 坏味项,无行为变化):expandHome 归位 core/backend.ts(消除 hub-backend 重复实现);单行粘贴守卫提取为 core 导出的 hasSingleLineBody(ssh/prometheus 两 provider 共用);ops-shell-tool 导出 shellToolOutput 契约,ops-tool-prometheus 复用替代逐字拷贝;hub-backend.listRequests 去掉从未使用的 status 参数;access-ui badge 的 pendingRequestCount 内联。另新增私有 test-support 包,合并三份逐字相同的 tests/tmpdir.ts。

## 0.3.0

### Minor Changes

- 8583b23: 新增 `ACCESS_HUB_URL` 环境变量接缝:未显式配置 `source` 时,设置该环境变量即切换 hub 模式(`hubUrl` 也用它兜底)。动因:preset 落盘文件(`~/.dsh/.agent-presets/ops/agent.cordis.yml`)每次套件升级重装都会被重写,写进去的 hub 配置会被静默冲掉、部署悄悄退回 yaml 模式;而 profile 的 `cordis.patch.yml` 只能打 host 面的补丁,够不到 preset 面的 access core。进程环境变量(systemd unit)是唯一升级不丢的开关。显式 `source: yaml` 仍可压住环境变量。

## 0.2.1

### Patch Changes

- 4d28c14: 修复 0.2.0 发布物缺文件:`files` 白名单漏掉了 access-hub 新增的 `lib/backend.js`/`lib/hub-backend.js`(导致 npm 安装下 ops preset 挂载失败、所有 ops-access 路由 404)和 access-ui 的 `lib/candidates.js`(@ access 候选模块缺失、客户端插件加载失败)。ops-panel 顺带补上 `lib/types.js`。四个包的 `files` 统一改为 `lib/**/*.js` + `lib/**/*.d.ts` 通配,并新增 `scripts/check-pack-files.mjs` 打包覆盖检查接入 CI,防再犯。

## 0.2.0

### Minor Changes

- 67c6abe: Add a pluggable credential source: `ops-access` can now resolve entries from a remote **ops-access-hub** service (`source: 'hub'` with `hubUrl`/`hubToken`/`hubAdminToken`) in addition to the default local YAML registry. In hub mode, file-field content is fetched per resolve and materialized to managed local files (0600), so profiles still carry only paths and all consumers (tools, gate, admin UI) work unchanged. The YAML source is byte-for-byte compatible; `register_access`, the admin routes, probes, and the broker flow work against both sources.
  
  Hub-mode materialized files are a TTL-bound cache under `hubCacheDir` (default `~/.dsh-ops/hub-cache`, deliberately separate from the yaml `credentialsDir` so the documented fallback is never swept): startup sweeps the whole cache (the grant ledger dies with the process — cached rw material must not outlive it), an interval sweep expires files past `materializeTtlMinutes` (default 15), and resolve re-materializes transparently on demand. Reference expansion (ADR-0007) goes through the same `loadTier`, so referenced credentials (ssh-cred) materialize at expansion time with the same discipline.
- b8bb955: Agent-submitted rw registration requests with human approval (ADR-0008). The `register_access` tool gains `tier: "rw"` and `reason` parameters: instead of writing (rw stays human-approved), it validates the fields exactly like a real write (provider content hooks + zod schema) and queues a registration request on the hub (hub mode only; yaml mode fails with guidance). The admin settings section (凭证管理) gains a "待审批注册申请" block listing pending requests; reviewing one shows the full field contents (the only place secrets render in this UI — seeing the material is the point of approval), and approving writes the tier via new core proxy routes (`/ops-access/admin/requests`, `/detail`, `/decide`) so the browser never holds the hub token.
- bf99896: Session-hardening batch from a real 25-hour incident review (2026-09-10 jumpserver/ceph/IB session log):
  
  - **kubectl/ceph: shell composition rejected.** The `command` arg is concatenated after the tool's binary prefix, so `;`/`&&`/`||`/backticks/`$()`/newlines used to start a NEW local command without prefix or credentials, surfacing as a misleading `get: command not found` (hit 8+ times across 7 turns). Now rejected before execution with a teaching error; a single `|` pipe (local output filter) stays allowed. Both tools also gain an optional `timeoutSec` parameter (1–600s) for known-slow commands (`rados ls` on large pools hit the fixed 30s ceiling).
  - **Profile-name idempotency.** `opsAccess.resolve`/`canResolve` tolerate a redundant `kind/` prefix (`resolve('ssh', 'ssh/b200-02')` now works) — agents routinely pass the recall token whole.
  - **Provider-declared `knownLimits`.** Mention recall and `list_access help` now carry the kind's known ro-tier boundaries: k8s documents the view-ClusterRole blindspots (nodes/PVs/storageclasses/volumeattachments/Secrets → Forbidden), ceph the ro caps boundary (tell/fs-subvolume/rbd-management → EACCES). The agent learns the credential boundary from the text, not from a 403 it re-hits after every compaction.
  - **gate: realistic TTL options.** Default `grantTtlOptions` becomes `[10, 30, 60, 120]` — with `[5, 10, 30]` every 60/120-min request was clamped to 30, forcing repeat full approvals mid-incident. The tool description now steers toward the smallest sufficient lifetime and names the panel options; an unanswered request's timeout message now tells the agent to ping the user (panel `/access-all`) instead of failing silently.
  - **trace: stale-step reminder + honest force.** New `trace:stale-step` reminder nudges when open steps (pending/in_progress) have gone 4+ turns (configurable via `staleStepReminderTurns`) without a decision — the second-half rot the idle rule cannot see (dead ends unrecorded until the user asked twice). A force-resolve WARN now names the undecided nodes it shelved and states the closure is an UNVERIFIED assertion; the `force` param doc restricts it to abandoning an investigation.
  - **ops-prompts: new `ib-rdma` skill.** The IB/RDMA investigation methodology an agent improvised mid-incident, distilled: per-port fabric enumeration (one host, several fabrics), SM liveness via activity-count growth, "SM unreachable ≠ data-plane blackhole" (VL15 vs VL0 discriminator), directed-route topology crawl without SM, and error/flap counters (`ibqueryerrors`, `carrier_changes`) as hypothesis executioners.
- 401a8a7: SSH 凭证与主机分离：新增 `ssh-cred` 凭证种类（密钥或密码登记一次、多台主机经 `cred` 引用共享，轮换只改一处）;core 增加通用引用机制（provider 声明 `references`,resolve 时把被引用条目字段合并到引用方之下，broker 只对引用方咨询一次）与 `validateResolved` 合并后校验钩子；ssh 工具支持密码登录（`sshpass -f`，密码型档案关闭 BatchMode),dsh 宿主机需安装 sshpass。主机条目内联 `key` 的旧写法继续可用。详见 ADR-0007。

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

### Patch Changes

- e6aa27b: Fixed a deployment-breaking dependency declaration: `@deepseek-ai/dsh-tools` (and `@deepseek-ai/dsh-llm` in the gate) sat in `dependencies`, so installing the suite from npm placed a second, older copy of dsh-tools in the profile's `node_modules`. That copy shadowed the harness installation when the loader resolved the host composition's `tools` row, producing a second `TOOL_RUNTIME_SCHEDULER` symbol instance — every tool call then died with `Cannot read properties of undefined (reading 'prepare')`. Both packages now declare these as `peerDependencies`, matching the rest of the suite. All `@deepseek-ai/*` peer ranges are also aligned from `^0.0.1-rc.1` to `^0.1.0-rc.8`, the harness line they actually run against.

## 0.1.2

## 0.1.1
