# @deepseek-ai/dsh-ops-shell-tool

Shared factory for ops-access consumer tools: the standard shell result shape `{ exitCode, stdout, stderr, command, error? }`, its output schema and render, and the resolve-per-call execute template.

## What it does

A pure library (not a plugin) — the single home for the boilerplate every ops command tool (`ops-tool-kubectl`, `ops-tool-ceph`, `ops-tool-ssh`) would otherwise duplicate. A consumer calls `registerProfiledShellTool(ctx, spec)` from its own plugin and keeps only its identity: tool name, the ops-access kind it resolves, the profile-arg name, and `buildCommand`.

- **Standard result shape** — one `ShellToolResult` definition, one output schema, one pure render, shared by every consumer tool.
- **Resolve per call** — the profile is resolved through `ctx.get('opsAccess')` inside execute, never statically injected, never cached.
- **Credential tokens** — `buildCommand` marks file-bearing fields with `ref(field)`, which mints a display token `<id@tier:field>`; the executed command carries the shell-quoted real value, while the displayed command and all captured stdout/stderr are scrubbed back to tokens. Credential paths never reach the model or the session event log.
- **Honest kill reporting** — 30 s default timeout; a signal death normalizes to `exitCode: -1` with the cause (timeout / caller abort / signal name) spelled out in the `error` field, never a bare -1.
- **stderr noise filtering** — consumer-declared regexes drop known-noise stderr lines (e.g. ceph keyring chatter) after scrubbing.
- **`shellQuote`** — exported for consumers that must embed a whole remote command as one argument (ops-tool-ssh).

## Design notes

- **Why a factory, not a base plugin:** the three consumer tools differ only in identity pieces. Owning the execute template here means timeout handling, kill notes, and credential scrubbing are fixed once, not three times.
- **Why `ctx.get` per call instead of a static inject:** the preset mounts the group concurrently, so a static `inject: ['opsAccess']` risks a loader deadlock against the definition row; by tool-call time the service is long since provided. Same discipline as the registry file itself: resolve per operation, cache nothing.
- **Why per-call tokens:** token → value mappings live only inside one execute, so a credential path can never leak across calls or sessions.

## Configuration

None — the package has no plugin `Config`. All behavior is parameterized per consumer through `ProfiledShellToolSpec`: `name`, `kind`, `targetParam`, the three description strings, `buildCommand`, `timeoutMs` (default 30000), and `stderrNoise`.

## Testing

```sh
npx vitest run
```

The spec drives the factory through a mock ctx: resolve-per-call, agent passthrough, the absent-seam guard, error passthrough, exitCode normalization, timeout/abort/signal kill notes, credential token substitution and scrubbing, stderr noise filtering, render purity, and HMR unload (the registered tool disappears when the fiber's effect disposers run).
