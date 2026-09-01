# @deepseek-ai/dsh-ops-access-ceph

The Ceph credential provider for DeepSeek Harness ops mode — validates `ceph` registry entries (ceph.conf + keyring), expands their paths, and probes claimed ro/rw tiers against the cluster's real cephx caps at save time.

## What it does

One provider per credential kind, per the ops-access three-role split: core owns the registry and the `ctx.opsAccess` service; this package supplies only the ceph kind — a zod entry schema plus field processing.

- **Entry schema**: `{ conf, keyring, name? }` — the admin UI accepts ceph.conf and keyring CONTENT; core writes them to managed files under `~/.dsh-ops/credentials/` and stores the paths. `name` is the cephx entity (defaults to `client.admin`).
- **process**: expands a leading `~` in both paths for the tool's `--conf`/`--keyring` flags.
- **validateContent**: save-time paste guard — `[global]` + `mon_host` required in the conf; an indented strict-base64 `key =` line under a `[client.x]` section in the keyring. Structural only, no connectivity checks.
- **Capability probe** (ticket 10): at save time re-reads the entity's caps via `ceph auth get` and compares with the claimed tier. ro verifies only when no cap grants write (permission bundles like `rwx`/`wx` count; the `allow` keyword never does; pool qualifiers are inert). Failures degrade to `unverifiable` — a tight ro entity that cannot self-read its caps is normal, not an error.
- **derivationDoc**: the ro self-registration recipe (`client.<id>-ro` with `allow r` on mon/osd/mds/mgr), surfaced through `list_access` help.

## Design notes

- Structural validation lives in the provider, connectivity in the probe: a garbled paste fails at save time instead of surfacing as "cannot parse buffer: Malformed input" at connection time.
- Trailing-newline normalization is core's job (`normalizeTrailingNewline: true` opts in) — the provider no longer rejects a missing trailing newline.
- Probe stderr is classified by substring and never surfaced: ceph error messages can carry file paths.

## Configuration

Schemastery `Config`, one field:

- `probeTimeoutMs` (number, default `10000`) — timeout for the save-time `ceph auth get` call. Slow clusters may need more.

## Installation

Provider row of the ops preset's `agent.cordis.yml`:

```yaml
- id: ops-access-ceph
  name: '@deepseek-ai/dsh-ops-access-ceph'
```

Registration goes through `registerAccessProvider` (deferred `ctx.inject` + effect lifecycle, so HMR unloads it) — never a static `inject` on `opsAccess`, which deadlocks the loader.

## Testing

```sh
npm run build      # tsc → lib/
npx vitest run     # schema, process, paste guard, probe classification, registration/HMR disposal
```

No cluster needed: the live-probe test points at nonexistent paths and asserts the result degrades to `unverifiable` without leaking paths.
