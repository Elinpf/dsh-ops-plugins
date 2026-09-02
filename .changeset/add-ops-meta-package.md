---
'@elinpf/dsh-ops': patch
---

New package `@elinpf/dsh-ops`: the single deployment unit for the suite. One `dsh plugin add @elinpf/dsh-ops` pulls in every granular `@elinpf/dsh-ops-*` package as dependencies and mounts the host-plane rows via its bundle patch; the shipped `dsh-ops` bin materializes the `ops` agent preset into the agents home (`dsh-ops preset install|remove`). Installation/deployment docs now describe this single-package flow.
