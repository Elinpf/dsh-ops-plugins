---
"@elinpf/dsh-ops-tool-trace": patch
"@elinpf/dsh-ops-trace-ui": patch
---

Fix the trace panel never appearing under dsh ≥0.1.1: the session-projection contract changed (`stateSchema` + `wire.{viewSchema,view}`, wire-less units silently dropped from baselines and push frames), and `traceProjection` still carried only the ≤0.1.0-rc.8 shape (`schema` + top-level `view`). The definition now carries both shapes, so the `trace` projection is wire-visible on both contracts; peer range widened to `^0.1.0-rc.8 || ^0.1.1-rc.1`. No state-format change (`stateVersion` stays 5).
