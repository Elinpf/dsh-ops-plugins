# @elinpf/dsh-ops-access-ssh

SSH provider for the ops access seam — two credential kinds: `ssh` (a HOST entry) and `ssh-cred` (a reusable CREDENTIAL entry), so one key or password is registered once and shared by any number of hosts.

## What it does

One of the provider plugins behind `@elinpf/dsh-ops-access` (core). Core owns the YAML credential registry (`~/.dsh-ops/access.yaml`) and the `ctx.opsAccess` service; this package contributes two credential kinds via `registerAccessProvider`:

- **`ssh` — the host**: `host`, optional `user` / `key` / `password` / `port`, and optional `cred` — a reference to an `ssh-cred` entry. The intended shape is host + `cred`; inline `key`/`password` still work (legacy / one-off). At resolve time core merges the referenced credential's fields UNDER the host entry's — a `user` set on the host overrides the credential's default.
- **`ssh-cred` — the credential**: optional `user` (default login user), `key`, `password` — at least one of key/password required. Holds no host; it only resolves as the target of a `cred` reference. Register the secret once, point N hosts at it, rotate it in one place.
- **Field processing**: expands `~` in the key/password paths so `ssh -i` / `sshpass -f` see absolute paths.
- **Save-time validation**: key content gets a PEM armor check plus a REAL `ssh-keygen -y` parse (a structurally plausible but corrupt paste fails with a clear message instead of `error in libcrypto` mid-investigation; a passphrase-protected key gets its BatchMode explanation up front). Password content must be single-line — `sshpass -f` reads only the first line.
- **Pasted content**: when the admin UI receives key/password CONTENT (not a path), core writes it to a managed 0600 file under `~/.dsh-ops/credentials/`; both kinds opt into trailing-newline normalization (a key paste that lost the final newline of the END line failed in libcrypto at first use — 2026-08-27).

## Why this shape

The three-role rule (see the repo `AGENTS.md`): core owns the registry and the service, providers carry only a zod schema plus field processing, consumer tools resolve a profile and build the shell command. Keeping this package to schema + processing means no secret material ever passes through any service — profiles carry only paths and connection parameters.

The host/credential split uses core's generic `references` mechanism (`references: { cred: 'ssh-cred' }`): one resolve consults the broker once on the HOST entry — the referenced credential is an implementation detail, not a separately gated profile. A dangling reference fails the referring resolve (and its `canResolve` precheck) with a pointer to both entries.

Registration defers through `ctx.inject(['opsAccess'], ...)` inside `registerAccessProvider` and is tied to the plugin's effect lifecycle, so fiber disposal / HMR unload removes the providers from the registry.

## Installation

Add to `dsh-web-app` dependencies and reference in the ops preset's `agent.cordis.yml`:

```yaml
- id: ops-access-ssh
  name: '@elinpf/dsh-ops-access-ssh'
```

## Configuration

- `validateTimeoutMs` (number, default `5000`) — timeout for the save-time `ssh-keygen -y` parse.

## Testing

```sh
npm run build
npx vitest run
```

The spec covers schema accept/reject (both kinds), `~` expansion, the `cred → ssh-cred` reference declaration, post-merge user validation, registration/disposal through a mock `opsAccess` context (including HMR unload), and the validateContent armor gate + real `ssh-keygen` parse + single-line password rule (it generates throwaway ed25519 keys in a tmp dir).
