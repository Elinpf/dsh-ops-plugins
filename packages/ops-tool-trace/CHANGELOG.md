# @elinpf/dsh-ops-tool-trace

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
