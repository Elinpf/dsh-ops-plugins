---
"@elinpf/dsh-ops-access": minor
---

Add a pluggable credential source: `ops-access` can now resolve entries from a remote **ops-access-hub** service (`source: 'hub'` with `hubUrl`/`hubToken`/`hubAdminToken`) in addition to the default local YAML registry. In hub mode, file-field content is fetched per resolve and materialized to managed local files (0600), so profiles still carry only paths and all consumers (tools, gate, admin UI) work unchanged. The YAML source is byte-for-byte compatible; `register_access`, the admin routes, probes, and the broker flow work against both sources.

Hub-mode materialized files are a TTL-bound cache under `hubCacheDir` (default `~/.dsh-ops/hub-cache`, deliberately separate from the yaml `credentialsDir` so the documented fallback is never swept): startup sweeps the whole cache (the grant ledger dies with the process — cached rw material must not outlive it), an interval sweep expires files past `materializeTtlMinutes` (default 15), and resolve re-materializes transparently on demand. Reference expansion (ADR-0007) goes through the same `loadTier`, so referenced credentials (ssh-cred) materialize at expansion time with the same discipline.
