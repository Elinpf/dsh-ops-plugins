# @elinpf/dsh-ops-access

## 0.1.4

## 0.1.3

### Patch Changes

- e6aa27b: Fixed a deployment-breaking dependency declaration: `@deepseek-ai/dsh-tools` (and `@deepseek-ai/dsh-llm` in the gate) sat in `dependencies`, so installing the suite from npm placed a second, older copy of dsh-tools in the profile's `node_modules`. That copy shadowed the harness installation when the loader resolved the host composition's `tools` row, producing a second `TOOL_RUNTIME_SCHEDULER` symbol instance — every tool call then died with `Cannot read properties of undefined (reading 'prepare')`. Both packages now declare these as `peerDependencies`, matching the rest of the suite. All `@deepseek-ai/*` peer ranges are also aligned from `^0.0.1-rc.1` to `^0.1.0-rc.8`, the harness line they actually run against.

## 0.1.2

## 0.1.1
