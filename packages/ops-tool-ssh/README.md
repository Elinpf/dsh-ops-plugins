# @elinpf/dsh-ops-tool-ssh

The `ssh` tool for DeepSeek Harness ops mode — runs a command on a remote host over SSH, using a registered ssh access profile (key, port, user@host injected automatically).

## What it does

A consumer of the ops-access credential seam: the model calls `ssh` with a profile name and a command; the plugin resolves the profile through `opsAccess` and runs the command via `ctx.shell`. `BatchMode=yes` makes anything that would prompt fail fast, and `StrictHostKeyChecking=accept-new` trusts a host key on first contact while refusing changed ones. Use `list_access` to see available host names.

- The remote command is passed as ONE single-quoted argument — pipes, redirects, `&&`, `;` and `$()` all execute on the REMOTE host; the local shell never splits the line (an unquoted `&&` chain once came one auth failure short of deleting control-plane manifests locally, 2026-08-27 near-miss).
- Only the key path gets a per-call credential token; user@host and port stay inline. The display command (model-visible, logged) keeps tokens — only the executed command carries real values.
- Signal deaths (null exitCode) are normalized to exitCode -1, with the cause surfaced in `error`.

## Design

This package is deliberately thin. All shared machinery — result shape `{ exitCode, stdout, stderr, command, error? }`, output schema, render, and the resolve-per-call execute template (30 s default timeout) — lives in `@elinpf/dsh-ops-shell-tool`. A consumer tool only supplies four identity pieces: tool name, resolved credential kind, profile-arg name, and `buildCommand`. The ops-access seam is resolved per call through `ctx.get('opsAccess')`, never a static inject (the preset mounts the group concurrently — a static inject deadlocks the loader).

- `src/index.ts` — the plugin (function plugin: `name`/`inject`/`Config`/`apply`, no default export). Registration goes through `ctx.effect`, so fiber disposal/HMR unloads the tool.
- `src/types.ts` — pure types (no runtime values).
- `src/invariant.ts` — invariant companion; no runtime invariant (stateless tool, owns no session events), registers package ownership only.

## Configuration

```yaml
- id: ops-tool-ssh
  name: '@elinpf/dsh-ops-tool-ssh'
  timeoutMs: 30000            # per-call shell timeout (ms)
  connectTimeoutSeconds: 10   # ssh -o ConnectTimeout (TCP handshake wait)
```

## Testing

```sh
npm run build
npx vitest run
```

Tests mount the plugin against a mock context (`tests/harness.ts`) that captures tool registrations, shell resolve/run calls, and effect disposers — covering command assembly, quoting, credential tokens, error fallbacks, render purity, and HMR unload.
