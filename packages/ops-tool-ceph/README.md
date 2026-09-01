# @deepseek-ai/dsh-ops-tool-ceph

The `ceph` tool for DeepSeek Harness ops mode — resolves a named Ceph cluster profile through the ops-access seam and runs `ceph` / `rbd` / `rados` against it via `ctx.shell`, injecting the credential paths automatically.

## What it does

The model calls `ceph` with a `cluster` (profile name) and a `command`. The tool resolves the profile on every call (no caching — credential edits take effect immediately), builds the real command line with the profile's `--conf` / `--keyring` (and `--name` when the profile carries a cephx user) injected as `<id@tier:field>` token references, runs it through the shell service with a 30 s timeout, and returns the standard `{ exitCode, stdout, stderr, command, error? }` result.

## Design notes

- **Thin consumer, shared machinery.** This package supplies only four identity pieces — tool name, resolved kind (`ceph`), profile-arg name (`cluster`), and `buildCommand`. Everything else (result shape, output schema, render, resolve-per-call execute template, timeout and signal-death normalization) lives in `@deepseek-ai/dsh-ops-shell-tool`, so the three consumer tools (`kubectl` / `ceph` / `ssh`) cannot drift apart.
- **First word picks the binary.** `rbd` and `rados` are SEPARATE binaries, not ceph subcommands — `ceph rbd ls` is a mon-side "no valid command found". The command's first word selects from the allowlist `[ceph, rbd, rados]`; a bare word is treated as a ceph subcommand.
- **Boundary errors over misleading ones.** Host-local ceph-ecosystem binaries (`mount.ceph`, `ceph-fuse`, `ceph-volume`, `rbd-nbd`, …) are explicitly NOT wrapped; such a call fails with a clear message pointing at the `ssh` tool instead of the mon's confusing error.
- **stderr noise filtering.** The two known "no keyring under /etc/ceph" warnings (pure noise when credentials arrive via injected `--keyring`) are matched exactly and dropped; every other stderr line passes through verbatim.
- **No secret material in band.** Profiles carry only paths and connection parameters; file paths become `<id@tier:field>` tokens in the assembled command, and the cephx entity name (not secret) stays inline. Read-only enforcement happens at the mon/osd via the credential's caps, never in this tool.
- **Registration is an effect.** The tool registers via `ctx.effect(() => ctx.tools.register(...))` (inside `registerProfiledShellTool`), so fiber disposal / HMR unloads it cleanly. The `./invariant` subpath registers a no-op invariant companion: the tool is stateless and owns no session events, so there is no runtime invariant to install.

## Configuration

Schemastery schema, one option:

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Per-call shell timeout for ceph runs (ms). Slow clusters may need more. |

## Testing

```sh
npm run build     # tsc → lib/ (plugins load lib/, not src/)
npx vitest run    # unit tests against a mock ctx (shell / tools / opsAccess)
```

The suite covers command assembly (ceph / rbd / rados / explicit-prefix stripping / `--name` injection), the not-wrapped boundary, profile-resolution and shell failure mapping, stderr noise filtering, render purity, export shape (`.` / `./invariant` / `./types` entries), and HMR unload (running every collected effect disposer unregisters the tool).
