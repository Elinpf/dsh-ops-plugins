# @elinpf/dsh-ops-access-ceph

## 0.3.0

### Patch Changes

- Updated dependencies [8583b23]
  - @elinpf/dsh-ops-access@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [4d28c14]
  - @elinpf/dsh-ops-access@0.2.1

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

- Updated dependencies [67c6abe]
- Updated dependencies [b8bb955]
- Updated dependencies [bf99896]
- Updated dependencies [401a8a7]
  - @elinpf/dsh-ops-access@0.2.0

## 0.1.7

### Patch Changes

- @elinpf/dsh-ops-access@0.1.7

## 0.1.6

### Patch Changes

- @elinpf/dsh-ops-access@0.1.6

## 0.1.5

### Patch Changes

- @elinpf/dsh-ops-access@0.1.5

## 0.1.4

### Patch Changes

- @elinpf/dsh-ops-access@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [e6aa27b]
  - @elinpf/dsh-ops-access@0.1.3

## 0.1.2

### Patch Changes

- @elinpf/dsh-ops-access@0.1.2

## 0.1.1

### Patch Changes

- @elinpf/dsh-ops-access@0.1.1
