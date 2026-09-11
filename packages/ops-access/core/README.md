# @elinpf/dsh-ops-access

The ops access capability seam — owns the YAML credential registry (default `~/.dsh-ops/access.yaml`) and exposes `ctx.opsAccess` (resolve / list / register) to provider plugins and consumer tools.

## What it does

- **Single registry file, zero cache**: every `resolve`/`list`/`writeEntry` re-reads, re-parses, and re-validates the YAML — edits take effect immediately, no restart.
- **Tiered entries**: each profile carries an `ro` tier (agent-readable default) and an `rw` tier (served only through a registered broker grant).
- **Provider seam**: one provider per credential kind (`k8s`/`ceph`/`ssh` packages) supplies only a zod schema plus field processing (`~` expansion, content validation, capability probe). Providers register via `registerAccessProvider(ctx, provider)` — never hand-write `ctx.inject` for sibling services, it deadlocks the loader.
- **Reference fields** (`references`): a provider may declare that a field names another KIND's entry (ssh's `cred` → `ssh-cred`), so many entries share one credential instead of each carrying a copy. At resolve time core merges the referenced entry's fields UNDER the referring entry's (same registry, same tier, one level only); the broker is consulted once, on the referring entry. `validateResolved` is the post-merge hook for requirements that only hold on the merged shape (ssh needs a login user from either side). A dangling reference fails the referring resolve AND its `canResolve` precheck.
- **`register_access` tool**: the agent's self-service path for writing the ro tier; with `tier: "rw"` it instead **submits an rw registration request** (hub mode only, ADR-0008) — the request queues on the hub and is written only after an operator reviews the field contents and approves it in the admin settings section.
- **Mention support**: `@[kind/name](dsh-access:<payload>)` mentions are parsed on `agent/pre-step` and rewritten to readable references with envelope context; `GET /ops-access/list` feeds the browser's `@` picker. The encoding lives in the `./mention` subpath.
- **Admin routes**: `GET /ops-access/admin/list`, `GET /ops-access/admin/kinds`, `GET|POST|DELETE /ops-access/admin/entry` — envelope + validation status only, never field values.
- **Pluggable credential source** (`source`): `yaml` (default) is the local registry file; `hub` fetches entries from a standalone [ops-access-hub](../../ops-access-hub/) service on every call. In hub mode, file-field content is materialized to a SEPARATE cache dir (`hubCacheDir`, default `~/.dsh-ops/hub-cache`) as a TTL-bound cache (`materializeTtlMinutes`, default 15) — never a permanent copy: startup sweeps the whole cache (the grant ledger dies with the process, so cached rw material must not outlive it), the interval sweep expires by age, and resolve re-materializes transparently on demand. The yaml-mode `credentialsDir` (the documented fallback) is never swept.

## Design notes

- **Secrets never cross**: profiles carry only file paths and connection parameters — logs, errors, and model context cannot contain secret material. File-field content is write-only after save (`getEntry` withholds even the stored path).
- **Why the seam is split**: core owns the registry file and the service; providers own per-kind field knowledge; consumer tools (`ops-tool-kubectl` & co.) own command building. Each side changes independently.
- **Broker, not gatekeeper-in-core**: policy (who may read rw) lives in a registered `AccessBroker` — a pure decision function consulted on every resolve. Without one, resolve serves ro byte-for-byte as before.
- **Everything is an effect**: tool, routes, provider and broker registrations are all tied to the cordis effect lifecycle, so fiber disposal / HMR unload removes them cleanly.

## Configuration

```yaml
- id: ops-access
  name: '@elinpf/dsh-ops-access'
  registryFile: ~/.dsh-ops/access.yaml   # default
  credentialsDir: ~/.dsh-ops/credentials # default; managed credential content files (0600)
  # source: hub                          # optional; default yaml
  # hubUrl: http://127.0.0.1:3090        # hub source: hub base URL
  # hubToken: ...                        # hub source: read token (or env ACCESS_HUB_READ_TOKEN)
  # hubAdminToken: ...                   # hub source: write token (or env ACCESS_HUB_ADMIN_TOKEN)
  # hubCacheDir: ~/.dsh-ops/hub-cache    # hub source: TTL materialization cache (never credentialsDir)
  # materializeTtlMinutes: 15            # hub source: cache TTL; startup sweeps all
```

## Testing

```sh
npm run build      # tsc → lib/
npx vitest run     # specs drive the real plugin through a mock context
                   # against a real tmp-dir registry file
```

## Known Limitations and Deferred Work

- No caching means a stat+parse per call — fine at ops-scale registries.
- `ssh` providers cannot capability-probe (no read-only shell to test) — their tiers stay unprobed.
- The registry file is human-editable by design; there is no lock against concurrent writers.
