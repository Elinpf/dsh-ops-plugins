# @deepseek-ai/dsh-ops-access-ssh

SSH credential provider for the ops access seam — validates `ssh` registry entries (`{ host, user, key?, port? }`) and expands key paths for the ssh consumer tool.

## What it does

One of three provider plugins behind `@deepseek-ai/dsh-ops-access` (core). Core owns the YAML credential registry (`~/.dsh-ops/access.yaml`) and the `ctx.opsAccess` service; this package contributes exactly one credential kind, `ssh`, via `registerAccessProvider`:

- **Entry schema** (zod): `host`, `user`, optional `key` (private-key path), optional `port`
- **Field processing**: expands `~` in the key path so `ssh -i` sees an absolute path
- **Save-time key validation** in two layers: a cheap PEM armor check, then a REAL parse via `ssh-keygen -y` — a structurally plausible but corrupt paste fails with a clear message instead of `error in libcrypto` mid-investigation, and a passphrase-protected key gets its BatchMode explanation up front
- **Pasted key content**: when the admin UI receives key CONTENT (not a path), core writes it to a managed file under `~/.dsh-ops/credentials/`; the provider opts into trailing-newline normalization (a paste that lost the final newline of the END line failed in libcrypto at first use — 2026-08-27)

## Why this shape

The three-role rule (see the repo `AGENTS.md`): core owns the registry and the service, providers carry only a zod schema plus field processing, consumer tools resolve a profile and build the shell command. Keeping this package to schema + processing means no secret material ever passes through any service — profiles carry only paths and connection parameters.

Registration defers through `ctx.inject(['opsAccess'], ...)` inside `registerAccessProvider` and is tied to the plugin's effect lifecycle, so fiber disposal / HMR unload removes the provider from the registry.

## Installation

Add to `dsh-web-app` dependencies and reference in the ops preset's `agent.cordis.yml`:

```yaml
- id: ops-access-ssh
  name: '@deepseek-ai/dsh-ops-access-ssh'
```

## Configuration

- `validateTimeoutMs` (number, default `5000`) — timeout for the save-time `ssh-keygen -y` parse.

## Testing

```sh
npm run build
npx vitest run
```

The spec covers schema accept/reject, `~` expansion, registration/disposal through a mock `opsAccess` context (including HMR unload), and the validateContent armor gate + real `ssh-keygen` parse (it generates throwaway ed25519 keys in a tmp dir).
