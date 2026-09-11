# @elinpf/dsh-ops-access-prometheus

The Prometheus credential provider for DeepSeek Harness ops mode — validates `prometheus` registry entries (server URL + optional bearer token) and expands the token path.

## What it does

One provider per credential kind, per the ops-access three-role split: core owns the registry and the `ctx.opsAccess` service; this package supplies only the prometheus kind — a zod entry schema plus field processing.

- **Entry schema**: `{ url, token? }` — `url` is the Prometheus server's base URL (http(s) only). `token` is optional bearer-token CONTENT: the admin UI / `register_access` accept the pasted token, core writes it to a managed file under `~/.dsh-ops/credentials/` and stores the path — the token never sits in the registry.
- **process**: strips trailing slashes from the URL and expands a leading `~` in the token path.
- **validateContent**: save-time paste guard — a token must be a single line (it is sent verbatim in the `Authorization` header; an interior newline would fail at request time). Structural only, no connectivity checks.
- **No capability probe**: the Prometheus HTTP API is read-only by nature (`query`/`query_range`), so there is no ro/rw distinction to verify. `knownLimits` says so and points at pairing with the same cluster's k8s profile.

## Installation

Provider row of the ops preset's `agent.cordis.yml`:

```yaml
- id: ops-access-prometheus
  name: '@elinpf/dsh-ops-access-prometheus'
```

Registration goes through `registerAccessProvider` (deferred `ctx.inject` + effect lifecycle, so HMR unloads it) — never a static `inject` on `opsAccess`, which deadlocks the loader.

## Testing

```sh
npm run build      # tsc → lib/
npx vitest run     # schema, process, paste guard, registration/HMR disposal
```

No server needed: all tests run against the pure provider object and a mock mount.
