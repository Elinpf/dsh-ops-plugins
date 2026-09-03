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

- DeepSeek Harness ≥ 0.1.0-rc (verified on 0.1.0-rc and 0.1.1-rc.2)
- pnpm ≥ 10
- `kubectl` on the host with cluster network reachability; `ceph` / `ssh` as needed

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
