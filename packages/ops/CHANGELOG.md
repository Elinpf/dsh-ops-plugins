# @elinpf/dsh-ops

## 0.4.0

### Patch Changes

- 1015b6b: 新包 `@elinpf/dsh-ops-knowledge` — 排错知识库插件: `knowledge_search` / `knowledge_record` / `knowledge_hit` 三个模型工具(access hub `/cases` 后端), 经 ops-prompts 注册静态 methodology(先搜后沉淀、采用计数纪律) + 每会话一次的病例索引 reminder(按 hitCount 取 top 10)。病例除结论(症状/根因/修复)外还有可选 methodology(排查方法论: 关键判别步骤) 和 difficulty(1-5 难度自评) 字段; `knowledge_search` 支持 query="*" 浏览全量。无 hub 配置时整体 no-op; hub 不可达时工具返回错误结果而非抛出。trace 的 doctrine HELP_TEXT 新增「收口后的知识沉淀」段, ops 部署包的 preset 带上 `tool-ops-knowledge` 行(无 config, 走 `ACCESS_HUB_URL`/`ACCESS_HUB_READ_TOKEN` 环境变量)。
- Updated dependencies [5d1a604]
- Updated dependencies [1015b6b]
- Updated dependencies [34bc97e]
  - @elinpf/dsh-ops-access@0.4.0
  - @elinpf/dsh-ops-access-gate@0.4.0
  - @elinpf/dsh-ops-tool-prometheus@0.4.0
  - @elinpf/dsh-ops-knowledge@0.4.0
  - @elinpf/dsh-ops-tool-trace@0.4.0
  - @elinpf/dsh-ops-access-ssh@0.4.0
  - @elinpf/dsh-ops-access-prometheus@0.4.0
  - @elinpf/dsh-ops-access-ui@0.4.0
  - @elinpf/dsh-ops-access-ceph@0.4.0
  - @elinpf/dsh-ops-access-k8s@0.4.0
  - @elinpf/dsh-ops-tool-ceph@0.4.0
  - @elinpf/dsh-ops-tool-environment@0.4.0
  - @elinpf/dsh-ops-tool-kubectl@0.4.0
  - @elinpf/dsh-ops-tool-ssh@0.4.0
  - @elinpf/dsh-ops-panel@0.4.0
  - @elinpf/dsh-ops-prompts@0.4.0
  - @elinpf/dsh-ops-trace-ui@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8583b23]
  - @elinpf/dsh-ops-access@0.3.0
  - @elinpf/dsh-ops-access-ceph@0.3.0
  - @elinpf/dsh-ops-access-gate@0.3.0
  - @elinpf/dsh-ops-access-k8s@0.3.0
  - @elinpf/dsh-ops-access-prometheus@0.3.0
  - @elinpf/dsh-ops-access-ssh@0.3.0
  - @elinpf/dsh-ops-tool-ceph@0.3.0
  - @elinpf/dsh-ops-tool-environment@0.3.0
  - @elinpf/dsh-ops-tool-kubectl@0.3.0
  - @elinpf/dsh-ops-tool-prometheus@0.3.0
  - @elinpf/dsh-ops-tool-ssh@0.3.0
  - @elinpf/dsh-ops-access-ui@0.3.0
  - @elinpf/dsh-ops-panel@0.3.0
  - @elinpf/dsh-ops-prompts@0.3.0
  - @elinpf/dsh-ops-tool-trace@0.3.0
  - @elinpf/dsh-ops-trace-ui@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [4d28c14]
  - @elinpf/dsh-ops-access@0.2.1
  - @elinpf/dsh-ops-access-ui@0.2.1
  - @elinpf/dsh-ops-panel@0.2.1
  - @elinpf/dsh-ops-trace-ui@0.2.1
  - @elinpf/dsh-ops-access-ceph@0.2.1
  - @elinpf/dsh-ops-access-gate@0.2.1
  - @elinpf/dsh-ops-access-k8s@0.2.1
  - @elinpf/dsh-ops-access-prometheus@0.2.1
  - @elinpf/dsh-ops-access-ssh@0.2.1
  - @elinpf/dsh-ops-tool-ceph@0.2.1
  - @elinpf/dsh-ops-tool-environment@0.2.1
  - @elinpf/dsh-ops-tool-kubectl@0.2.1
  - @elinpf/dsh-ops-tool-prometheus@0.2.1
  - @elinpf/dsh-ops-tool-ssh@0.2.1
  - @elinpf/dsh-ops-prompts@0.2.1
  - @elinpf/dsh-ops-tool-trace@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [67c6abe]
- Updated dependencies [a06f6d8]
- Updated dependencies [bf99896]
- Updated dependencies [b8bb955]
- Updated dependencies [bf99896]
- Updated dependencies [401a8a7]
  - @elinpf/dsh-ops-access@0.2.0
  - @elinpf/dsh-ops-access-ui@0.2.0
  - @elinpf/dsh-ops-access-prometheus@0.2.0
  - @elinpf/dsh-ops-tool-prometheus@0.2.0
  - @elinpf/dsh-ops-tool-kubectl@0.2.0
  - @elinpf/dsh-ops-tool-ceph@0.2.0
  - @elinpf/dsh-ops-access-k8s@0.2.0
  - @elinpf/dsh-ops-access-ceph@0.2.0
  - @elinpf/dsh-ops-access-gate@0.2.0
  - @elinpf/dsh-ops-tool-trace@0.2.0
  - @elinpf/dsh-ops-prompts@0.2.0
  - @elinpf/dsh-ops-access-ssh@0.2.0
  - @elinpf/dsh-ops-tool-ssh@0.2.0
  - @elinpf/dsh-ops-tool-environment@0.2.0
  - @elinpf/dsh-ops-trace-ui@0.2.0
  - @elinpf/dsh-ops-panel@0.2.0

## 0.1.7

### Patch Changes

- Updated dependencies [e004cd5]
  - @elinpf/dsh-ops-tool-trace@0.1.7
  - @elinpf/dsh-ops-trace-ui@0.1.7
  - @elinpf/dsh-ops-access-ui@0.1.7
  - @elinpf/dsh-ops-access-ceph@0.1.7
  - @elinpf/dsh-ops-access@0.1.7
  - @elinpf/dsh-ops-access-gate@0.1.7
  - @elinpf/dsh-ops-access-k8s@0.1.7
  - @elinpf/dsh-ops-access-ssh@0.1.7
  - @elinpf/dsh-ops-panel@0.1.7
  - @elinpf/dsh-ops-prompts@0.1.7
  - @elinpf/dsh-ops-tool-ceph@0.1.7
  - @elinpf/dsh-ops-tool-environment@0.1.7
  - @elinpf/dsh-ops-tool-kubectl@0.1.7
  - @elinpf/dsh-ops-tool-ssh@0.1.7

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
