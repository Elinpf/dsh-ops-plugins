# @elinpf/dsh-ops-access-hub

English | [中文](README.zh.md)

Standalone credential hub for the dsh ops suite — **not a dsh plugin**. A small, separately deployable service that stores every ops-access credential in a single AES-256-GCM-encrypted document and serves it over a token-authenticated HTTP API, with a minimal web UI and a YAML registry importer. `@elinpf/dsh-ops-access` (core) can use it as its credential source (`source: 'hub'`); the hub itself is dumb storage — kind schemas, validation, and probes all stay on the access side.

## What it does

- **Encrypted-at-rest storage.** The whole dataset is one JSON document (`<data-dir>/hub-data.json.enc`), AES-256-GCM with a random nonce per write, atomic write-temp-then-rename, mode 0600. The master key comes from env `ACCESS_HUB_KEY` (base64/hex) or a key file (default `<data-dir>/hub.key`, generated 0600 on first start). File fields hold their *content*, not paths.
- **Dual-token HTTP API** (bare `node:http`, default bind `127.0.0.1:3090`): an admin token for everything, a read token for listing and resolve; compared with `crypto.timingSafeEqual`, 401/403 distinguished.
- **Append-only audit log** (`<data-dir>/audit.log`, JSONL): every successful resolve/put/delete with the token role — never field values.
- **Single-file web UI** (`GET /`, Chinese): token input (localStorage), entry list with probe badges, create/edit/delete, audit viewer. The page itself holds no secrets.

## Usage

```sh
dsh-ops-access-hub serve [--port 3090] [--host 127.0.0.1] [--data-dir ~/.dsh-ops-hub] \
  [--key-file <file>] [--admin-token <t>] [--read-token <t>]

dsh-ops-access-hub import <access.yaml> \
  (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
```

Every `serve` flag has an env counterpart (`ACCESS_HUB_PORT`, `ACCESS_HUB_HOST`, `ACCESS_HUB_DATA_DIR`, `ACCESS_HUB_KEY_FILE`, `ACCESS_HUB_ADMIN_TOKEN`, `ACCESS_HUB_READ_TOKEN`). Tokens left unset are generated randomly and printed exactly once on first start.

`import` converts an existing ops-access YAML registry: a single-line field value starting with `/`, `~/`, `./` or `../` that points at a readable file is replaced by the file's content (relative paths resolve against the registry file's directory); everything else passes through unchanged. Push into a running hub with `--url`, or write the data file directly with `--data-dir`.

## API overview

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{ok:true}` |
| `GET /` | none | the static web UI |
| `GET /entries` | read+ | envelope + tier presence + probe per entry — **never field values** |
| `GET /entries/:kind/:name/:tier` | read+ | full fields for one tier (audited as `resolve`); 404 when absent |
| `PUT /entries/:kind/:name/:tier` | admin | upsert `{fields, envelope?, probe?}`; envelope replaces wholesale |
| `DELETE /entries/:kind/:name/:tier` | admin | removing the last tier deletes the whole entry |
| `GET /audit?limit=N` | admin | recent N audit records (default 100, cap 1000) |
| `GET /cases` | read+ | troubleshooting case index rows — metadata only, never full text |
| `GET /cases/:id` | read+ | one full case record |
| `POST /cases` / `PUT /cases/:id` | read+ | create / update a case — **deliberate role relaxation**: cases hold no secrets and the agent only carries the read token |
| `POST /cases/:id/hit` | read+ | bump a case's hit count |
| `DELETE /cases/:id` | admin | remove a case |

## Security notes

- v1 speaks plain HTTP and binds loopback by default — remote deployments must put the hub behind a TLS-terminating reverse proxy.
- The hub is a single point of custody: **back up both the data file and the master key.** Without the key the data file is unrecoverable.
- Keep tokens out of logs and shell history (prefer env injection); the read token suffices for consumers — only writers need the admin token.

## Testing

```sh
npm run build     # tsc → lib/
npx vitest run    # crypto round-trip, key-file generation and permissions,
                  # API auth (401/403), CRUD, last-tier cascade delete,
                  # probe write-back, audit append, import path→content
```
