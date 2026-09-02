# @elinpf/dsh-ops-kubectl

kubectl tool consumer of the ops-access capability seam — resolves `k8s` profiles into kubeconfig paths and runs kubectl via `ctx.shell`, plus a `list_access` tool that surfaces registered profiles without any secret fields.

## What it does

Registers two model-facing tools:

- **`kubectl`** — resolves a named `k8s` access profile per call and runs the given subcommand through the local shell with the profile's `--kubeconfig` path injected. The executed command carries the real path; the model-visible result shows a `<id@tier:field>` credential reference, so secrets never reach the log or the model.
- **`list_access`** — groups `ctx.opsAccess.listAll()` by kind and shows envelope fields only (name, displayName, description, environment) plus per-tier readiness (`ro`/`rw`) and capability-probe annotations. Profile `fields` (paths, connection params) never cross into tool output. `help: true` returns the registry management doc instead.

## Design notes

- **Thin consumer, shared machinery.** This package supplies only four identity pieces — tool name, resolved kind (`k8s`), profile-arg name (`cluster`), and `buildCommand`. The standard result shape (`{ exitCode, stdout, stderr, command, error? }`), output schema, render, and the resolve-per-call execute template (30 s default timeout, signal deaths normalized to exitCode -1) all live in `@elinpf/dsh-ops-shell-tool`, so kubectl/ceph/ssh tools behave identically.
- **Resolve per call, never cached.** The ops-access seam is reached through `ctx.get('opsAccess')` inside `execute` — no static inject, no caching — so registry edits take effect without restart and the loader never deadlocks on a sibling service.
- **No session state.** The tool appends no session events and owns no projection; every call is independent. The `./invariant` subpath ships a "no runtime invariant" companion that only reserves package ownership on the invariants service.

## Config

```yaml
- id: tool-ops-kubectl
  name: '@elinpf/dsh-ops-kubectl'
  config:
    timeoutMs: 30000   # per-call shell timeout for kubectl runs (ms); raise for slow clusters
```

## Subpath exports

- `@elinpf/dsh-ops-kubectl/types` — pure types (`ListedProfile`, `ListAccessResult`); zero runtime code.
- `@elinpf/dsh-ops-kubectl/invariant` — the invariant companion plugin.

## Testing

```sh
npm run build     # tsc → lib/
npx vitest run    # unit tests drive the real plugin through a mock context:
                  # kubectl happy path + failure fallbacks, render purity,
                  # list_access grouping with the no-fields guarantee,
                  # export shape, and HMR unload (disposers empty the registry)
```
