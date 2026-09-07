---
"@elinpf/dsh-ops-access": minor
---

Add a pluggable credential source: `ops-access` can now resolve entries from a remote **ops-access-hub** service (`source: 'hub'` with `hubUrl`/`hubToken`/`hubAdminToken`) in addition to the default local YAML registry. In hub mode, file-field content is fetched per resolve and materialized to managed local files (0600), so profiles still carry only paths and all consumers (tools, gate, admin UI) work unchanged. The YAML source is byte-for-byte compatible; `register_access`, the admin routes, probes, and the broker flow work against both sources.
