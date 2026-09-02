# @elinpf/dsh-ops

## 0.1.4

### Patch Changes

- 5aea699: New package `@elinpf/dsh-ops`: the single deployment unit for the suite. One `dsh plugin add @elinpf/dsh-ops` pulls in every granular `@elinpf/dsh-ops-*` package as dependencies and mounts the host-plane rows via its bundle patch; the shipped `dsh-ops` bin materializes the `ops` agent preset into the agents home (`dsh-ops preset install|remove`). Installation/deployment docs now describe this single-package flow.
- @elinpf/dsh-ops-access-ui@0.1.4
  - @elinpf/dsh-ops-access-ceph@0.1.4
  - @elinpf/dsh-ops-access@0.1.4
  - @elinpf/dsh-ops-access-gate@0.1.4
  - @elinpf/dsh-ops-access-k8s@0.1.4
  - @elinpf/dsh-ops-access-ssh@0.1.4
  - @elinpf/dsh-ops-panel@0.1.4
  - @elinpf/dsh-ops-prompts@0.1.4
  - @elinpf/dsh-ops-tool-ceph@0.1.4
  - @elinpf/dsh-ops-tool-environment@0.1.4
  - @elinpf/dsh-ops-tool-kubectl@0.1.4
  - @elinpf/dsh-ops-tool-ssh@0.1.4
  - @elinpf/dsh-ops-tool-trace@0.1.4
  - @elinpf/dsh-ops-trace-ui@0.1.4
