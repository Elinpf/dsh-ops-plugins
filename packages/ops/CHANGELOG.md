# @elinpf/dsh-ops

## 0.1.6

### Patch Changes

- 12e2125: ops-access: `register_access` 的文件类字段（kubeconfig、conf、keyring、key）现在也接受单行文件路径——服务端读取后走同一校验落盘，凭证内容不再需要经过模型上下文；路径无对应文件时报错明确点名两种写法（原来是误导性的 "not a YAML mapping"）。`list_access help`、工具 schema 描述与 admin UI 占位文案同步澄清「registry 收路径、工具收内容或路径」的区别。
- @elinpf/dsh-ops-access-ui@0.1.6
  - @elinpf/dsh-ops-access-ceph@0.1.6
  - @elinpf/dsh-ops-access@0.1.6
  - @elinpf/dsh-ops-access-gate@0.1.6
  - @elinpf/dsh-ops-access-k8s@0.1.6
  - @elinpf/dsh-ops-access-ssh@0.1.6
  - @elinpf/dsh-ops-panel@0.1.6
  - @elinpf/dsh-ops-prompts@0.1.6
  - @elinpf/dsh-ops-tool-ceph@0.1.6
  - @elinpf/dsh-ops-tool-environment@0.1.6
  - @elinpf/dsh-ops-tool-kubectl@0.1.6
  - @elinpf/dsh-ops-tool-ssh@0.1.6
  - @elinpf/dsh-ops-tool-trace@0.1.6
  - @elinpf/dsh-ops-trace-ui@0.1.6

## 0.1.5

### Patch Changes

- 7570122: Add `publishConfig.access: "public"` — the 0.1.4 publish of this new scoped package failed with npm E402 (scoped packages default to private), so the meta package never reached the registry while its 15 dependencies did.
- @elinpf/dsh-ops-access-ui@0.1.5
  - @elinpf/dsh-ops-access-ceph@0.1.5
  - @elinpf/dsh-ops-access@0.1.5
  - @elinpf/dsh-ops-access-gate@0.1.5
  - @elinpf/dsh-ops-access-k8s@0.1.5
  - @elinpf/dsh-ops-access-ssh@0.1.5
  - @elinpf/dsh-ops-panel@0.1.5
  - @elinpf/dsh-ops-prompts@0.1.5
  - @elinpf/dsh-ops-tool-ceph@0.1.5
  - @elinpf/dsh-ops-tool-environment@0.1.5
  - @elinpf/dsh-ops-tool-kubectl@0.1.5
  - @elinpf/dsh-ops-tool-ssh@0.1.5
  - @elinpf/dsh-ops-tool-trace@0.1.5
  - @elinpf/dsh-ops-trace-ui@0.1.5

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
