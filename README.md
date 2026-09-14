# dsh-ops-plugins

English | [中文](README.zh.md)

An ops plugin suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): it turns a dsh agent into a production-incident investigator — one that resolves kubectl / ceph / ssh credentials by name, runs read-only commands against your clusters, and organizes the investigation as a tree.

It installs as a single npm package, `@elinpf/dsh-ops`; the granular `@elinpf/dsh-ops-*` packages arrive as its dependencies, all published in lockstep versions.

## Features

- Credentials register paths only; the agent sees profile names — secrets never enter model context
- Read-only by default; read-write needs a per-session grant with human approval, fully audit-logged
- Honest tool output — sensitive paths are scrubbed before anything reaches the model
- The `trace` tool structures investigations as trees, rendered git-graph-style in the web UI
- Environment inventory scanning, so the agent reasons over what actually exists
- A few methodology lines in the system prompt; full docs pulled on demand

## Requirements

- DeepSeek Harness ≥ 0.1.0-rc (verified on 0.1.0-rc, 0.1.1-rc.2, and 0.1.5-rc.2)
- pnpm ≥ 10
- `kubectl` on the host with cluster network reachability; `ceph` / `ssh` as needed; `sshpass` too when using password-auth ssh profiles (network devices & co.)

## Installation

1. Install the package (dependencies and host-plane rows mount automatically):

   ```sh
   dsh plugin --profile ops add @elinpf/dsh-ops
   ```

2. For the web UI, edit `~/.dsh/profiles/ops/package.json` and add the web host to the bundles:

   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
         "@elinpf/dsh-ops"
       ]
     }
   }
   ```

   `@deepseek-ai/dsh-web-app` resolves through the dsh installation; it cannot be installed via `dsh plugin add`.

If the install fails with a `minimumReleaseAge` error, add an exclusion to the profile's `pnpm-workspace.yaml` (matching the current version):

```yaml
minimumReleaseAgeExclude:
  - '@elinpf/*@0.1.5'
```

## Deployment

1. Materialize the ops preset:

   ```sh
   npx @elinpf/dsh-ops preset install --agents-home ~/.dsh
   ```

   The harness discovers user presets under `~/.dsh/.agent-presets/`; without `--agents-home` the preset lands in `~/.agents` and fails silently.

2. Edit `~/.dsh/profiles/ops/cordis.patch.yml`, replacing the top-level array with:

   ```yaml
   - id: agent-presets
     config:
       default: ops
   - id: session-reference
     disabled: true
   ```

3. Start (`--no-open` skips opening a browser; flags match `dsh web`):

   ```sh
   dsh --profile ops --no-open
   ```

4. Register credentials in `~/.dsh-ops/access.yaml` — paths and connection parameters only, never secrets. `list_access` with `help: true` pulls the format docs; the web admin UI also covers registration.

Verify:

```sh
dsh --profile ops --dump-config | grep -A4 'id: agent-presets'      # default should be ops
dsh --profile ops --dump-config | grep -A2 'id: session-reference'  # should carry disabled: true
```

Then start an ops session in the web UI: `list_access` lists your profiles, `kubectl` resolves them, the trace panel renders, rw credential use raises an approval request.

## Central credential hub (optional)

By default credentials live in a local YAML registry on the dsh host. For a centralized store — one place to register, rotate, and audit credentials — run `@elinpf/dsh-ops-access-hub`, a standalone service (not a dsh plugin) that keeps every credential in a single AES-256-GCM-encrypted document and serves it over a small token-authenticated HTTP API with a built-in web UI.

1. Run the hub:

   ```sh
   npx @elinpf/dsh-ops-access-hub serve
   ```

   Options (flag / env / default): `--port` / `ACCESS_HUB_PORT` / `3090`; `--host` / `ACCESS_HUB_HOST` / `127.0.0.1`; `--data-dir` / `ACCESS_HUB_DATA_DIR` / `~/.dsh-ops-hub`; `--key-file` / `ACCESS_HUB_KEY_FILE` / `<data-dir>/hub.key`; `--admin-token` / `ACCESS_HUB_ADMIN_TOKEN` and `--read-token` / `ACCESS_HUB_READ_TOKEN` / generated and printed once on first start when unset. The master key comes from `ACCESS_HUB_KEY` (base64/hex) or the key file (auto-generated, mode 0600).

2. Migrate an existing YAML registry into the hub (path-shaped field values are inlined as file content):

   ```sh
   npx @elinpf/dsh-ops-access-hub import ~/.dsh-ops/access.yaml \
     --url http://127.0.0.1:3090 --admin-token <admin token>
   ```

   Offline alternative: `--data-dir <dir>` instead of `--url` writes the hub's data file directly.

3. Point ops-access at the hub by adding a config row to `~/.dsh/profiles/ops/cordis.patch.yml`:

   ```yaml
   - id: ops-access
     config:
       source: hub
       hubUrl: http://127.0.0.1:3090
       hubToken: <read token>          # or set env ACCESS_HUB_READ_TOKEN
       hubAdminToken: <admin token>    # or set env ACCESS_HUB_ADMIN_TOKEN
   ```

   Restart the profile afterwards. File-field contents are pulled from the hub per resolve and materialized to local files under `~/.dsh-ops/credentials` (mode 0600); profiles still carry only paths, and the access gate, probes, admin UI, and tools behave exactly as in YAML mode.

Security notes: v1 speaks plain HTTP — keep the default loopback bind or put the hub behind a TLS-terminating reverse proxy. The hub is a single point of custody: back up both the data file and the master key. The local YAML mode remains available as a fallback at any time.

## Having an agent install it

Paste this into any dsh session and let the agent run the installation and deployment for you:

```text
Read the README at https://github.com/Elinpf/dsh-ops-plugins,
install and deploy the @elinpf/dsh-ops plugin suite into the ops profile,
then confirm with the verification steps in the README.
```

## Updating

```sh
dsh plugin --profile ops add @elinpf/dsh-ops@latest
npx @elinpf/dsh-ops@latest preset install --agents-home ~/.dsh   # the preset is a file on disk — re-copy it
dsh --profile ops --no-open                                       # restart
```

Use `add @latest`, not `update` — `update` does not cross minors. The preset does not refresh with the package; re-materialize it.

## Uninstall

1. Remove the preset:

   ```sh
   npx @elinpf/dsh-ops preset remove --agents-home ~/.dsh
   ```

2. Remove the package:

   ```sh
   dsh plugin --profile ops remove @elinpf/dsh-ops
   ```

3. Restart the profile:

   ```sh
   dsh --profile ops --no-open
   ```

4. Optionally delete `~/.dsh-ops/` — the credential registry, environment inventory, and referenced credential files.

Uninstalling never touches your clusters: credentials are read-only references to files you own.

## Security

- Secrets never enter services, logs, errors, or model context
- The access gate's threat model is "prevent mistakes, not malice"
- Design decisions live in [`docs/adr/`](docs/adr/); the domain glossary (Chinese) is [`CONTEXT.md`](CONTEXT.md)
