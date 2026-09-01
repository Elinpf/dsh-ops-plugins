# @deepseek-ai/dsh-ops-access

The ops access capability seam — owns the YAML credential registry (default `~/.dsh-ops/access.yaml`) and exposes `ctx.opsAccess` (resolve / list / register) to provider plugins and consumer tools.

## What it does

- **Single registry file, zero cache**: every `resolve`/`list`/`writeEntry` re-reads, re-parses, and re-validates the YAML — edits take effect immediately, no restart.
- **Tiered entries**: each profile carries an `ro` tier (agent-readable default) and an `rw` tier (served only through a registered broker grant).
- **Provider seam**: one provider per credential kind (`k8s`/`ceph`/`ssh` packages) supplies only a zod schema plus field processing (`~` expansion, content validation, capability probe). Providers register via `registerAccessProvider(ctx, provider)` — never hand-write `ctx.inject` for sibling services, it deadlocks the loader.
- **`register_access` tool**: the agent's self-service path for writing the ro tier (rw stays human-managed via the admin HTTP routes).
- **Mention support**: `@[kind/name](dsh-access:<payload>)` mentions are parsed on `agent/pre-step` and rewritten to readable references with envelope context; `GET /ops-access/list` feeds the browser's `@` picker. The encoding lives in the `./mention` subpath.
- **Admin routes**: `GET /ops-access/admin/list`, `GET /ops-access/admin/kinds`, `GET|POST|DELETE /ops-access/admin/entry` — envelope + validation status only, never field values.

## Design notes

- **Secrets never cross**: profiles carry only file paths and connection parameters — logs, errors, and model context cannot contain secret material. File-field content is write-only after save (`getEntry` withholds even the stored path).
- **Why the seam is split**: core owns the registry file and the service; providers own per-kind field knowledge; consumer tools (`ops-tool-kubectl` & co.) own command building. Each side changes independently.
- **Broker, not gatekeeper-in-core**: policy (who may read rw) lives in a registered `AccessBroker` — a pure decision function consulted on every resolve. Without one, resolve serves ro byte-for-byte as before.
- **Everything is an effect**: tool, routes, provider and broker registrations are all tied to the cordis effect lifecycle, so fiber disposal / HMR unload removes them cleanly.

## Configuration

```yaml
- id: ops-access
  name: '@deepseek-ai/dsh-ops-access'
  registryFile: ~/.dsh-ops/access.yaml   # default
  credentialsDir: ~/.dsh-ops/credentials # default; managed credential content files (0600)
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
