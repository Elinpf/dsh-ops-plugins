# dsh-ops-plugins

English | [中文](README.zh.md)

An ops plugin suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): it turns a dsh agent into a production-incident investigator — one that resolves kubectl / ceph / ssh credentials by name, runs real read-only commands against your clusters, and organizes the whole investigation as a tree.

The suite publishes to npm as `@elinpf/dsh-ops-*` (15 packages, lockstep versions). Everything is a Cordis plugin; [`ops-preset.yml`](ops-preset.yml) in this repo is the reference composition.

## Why you'd want it

- **Credentials never enter the model's context.** Access profiles carry only paths and connection parameters; the agent sees profile *names*, never field values. `list_access` answers with names and descriptions only.
- **Read-only by default, read-write by explicit grant.** An access gate brokers every credential use per session: ro/rw tiers, human approval, revocable grants, and an audit log of every grant and revocation.
- **Honest tool output.** `kubectl` / `ceph` / `ssh` tools build exactly one command per call; real paths are scrubbed from command strings, stdout, and stderr back into display tokens before anything reaches the model or the session log.
- **Investigations are trees, not lists.** The `trace` tool structures incident response as a diverge-converge tree — steps, milestones, dead ends kept on record — rendered as a git-graph-style panel in the web UI.
- **The agent knows your environment.** A deterministic scanner builds an environment inventory (namespaces, deployments, ceph pools, hosts, cross-references, Prometheus corroboration) with TTL-driven refresh, so the agent reasons over "what exists" instead of guessing.
- **Methodology, not vibes.** A prompt channel injects a few core methodology lines into the system prompt plus per-step reminders; full documentation is pulled on demand, keeping token cost low.

## Requirements

- DeepSeek Harness, `dsh-v0.1.0-rc` line (see the [harness repo](https://github.com/deepseek-ai/deepseek-harness))
- `@deepseek-ai/cordis` v4 (pulled in automatically)
- Cluster-side binaries on the dsh host: `kubectl` (and cluster network reachability); `ceph`/`rbd`/`rados` and `ssh` only if you use those providers

## Installation

Install the plugin packages into your dsh profile. The minimal set is the access seam plus the providers you actually use — for example kubectl and ssh:

```sh
dsh plugin --profile <name> add @elinpf/dsh-ops-access
dsh plugin --profile <name> add @elinpf/dsh-ops-access-k8s
dsh plugin --profile <name> add @elinpf/dsh-ops-access-gate
dsh plugin --profile <name> add @elinpf/dsh-ops-access-ssh
dsh plugin --profile <name> add @elinpf/dsh-ops-tool-kubectl
dsh plugin --profile <name> add @elinpf/dsh-ops-tool-ssh
dsh plugin --profile <name> add @elinpf/dsh-ops-tool-trace
dsh plugin --profile <name> add @elinpf/dsh-ops-trace-ui
dsh plugin --profile <name> add @elinpf/dsh-ops-prompts
dsh plugin --profile <name> add @elinpf/dsh-ops-panel
dsh plugin --profile <name> add @elinpf/dsh-ops-access-ui
```

Add `@elinpf/dsh-ops-access-ceph` / `@elinpf/dsh-ops-tool-ceph` for ceph, and `@elinpf/dsh-ops-tool-environment` for the environment inventory. `@elinpf/dsh-ops-shell-tool` is a shared library and arrives as a dependency — never mount it directly.

## Deployment

The plugins are inert until an agent preset mounts them. The `ops` preset is the reference composition:

1. **Create the preset** in your agents home (default `~/.agents`), next to the built-in presets:

   ```
   ~/.agents/.agent-presets/ops/
   ├── preset.yml          # name / description / order
   └── agent.cordis.yml    # copy of this repo's ops-preset.yml
   ```

   `preset.yml` declares the preset's catalog entry, e.g.:

   ```yaml
   name: Ops mode
   description: For ops engineers: everything in standard mode, plus the investigation tree, credential registry (k8s/ceph/ssh), and shell tools.
   order: 5
   ```

2. **Point the profile at it** — add to the profile's `cordis.patch.yml`:

   ```yaml
   - id: agent-presets
     config:
       default: ops
   ```

   The `ops` preset replaces the upstream `session-reference` row for the `@`-mention picker; if you use the ops access picker, disable that row (`- id: session-reference` with `disabled: true`) so the ops source takes its slot.

3. **Restart the profile** (`dsh plugin add/remove` and preset edits need a restart; they do not hot-apply on the web surface).

4. **Register credentials.** Profiles are registered once in `~/.dsh-ops/access.yaml` — they carry paths and connection parameters, never secret material. The agent documents the format on demand (`list_access` with `help: true`), and a web admin UI covers registration with save-time validation.

Verify: open the web UI, start a session on the ops preset — `list_access` lists your profiles, `kubectl` commands resolve them, the trace panel renders, and rw credential use raises an approval request instead of running.

## Uninstall

1. Switch the profile's default preset back (or remove the `ops` preset directory from `~/.agents/.agent-presets/`), then restart the profile.
2. Remove the packages:

   ```sh
   dsh plugin --profile <name> remove @elinpf/dsh-ops-access
   # …repeat for each package added above
   ```

3. Restart the profile again.
4. Optionally remove the data directory `~/.dsh-ops/` — the credential registry (`access.yaml`), the environment inventory (`environment.yaml`), and the credential files themselves (keyrings, kubeconfigs, SSH keys referenced by profiles).

Uninstalling never touches your clusters: all the suite's credentials are read-only references to files you own.

## Security notes

- Secret material never enters services, logs, errors, or model context — credential files are written once at registration and referenced by path afterwards.
- The access gate's threat model is "prevent mistakes, not malice": it gates and audits accidental writes, it is not a defense against a hostile same-UID process.
- Design decisions live in [`docs/adr/`](docs/adr/); the domain glossary (Chinese) is [`CONTEXT.md`](CONTEXT.md).
