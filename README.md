# dsh-ops-plugins

An ops-scenario plugin suite for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): credential brokering, shell tools, an investigation tree, environment inventory, and the `ops` agent preset that composes them. Everything is a Cordis plugin; the 15 packages publish to npm as `@elinpf/dsh-ops-*` in lockstep versions ("插件集 vX").

## What you get

An agent that investigates production incidents instead of writing code:

- **Credentials without secrets in context** — profiles carry only paths and connection parameters (`~/.dsh-ops/access.yaml`); the registry is re-read on every resolve. `list_access` shows names and descriptions, never field values.
- **An access gate** — credential use is brokered per session with ro/rw tiers, human approval, and an audit log. Read-only by default; read-write requires an explicit, revocable grant.
- **Shell tools that stay honest** — `kubectl` / `ceph` / `ssh` tools resolve a profile by name and build one command per call; real paths are scrubbed from command strings, stdout, and stderr back into display tokens before anything reaches the model or the log.
- **An investigation tree** — the `trace` tool organizes incident response as a diverge-converge tree (steps, milestones, dead ends), rendered as a git-graph-style panel in the web UI.
- **Environment inventory** — a deterministic scanner (scan → classify → relations → Prometheus corroboration → `~/.dsh-ops/environment.yaml`) with TTL-driven refresh and anomaly annotations.
- **A prompt channel** — methodology sections in the system prompt and per-step reminders, with progressive disclosure: a few core lines always present, full docs pulled on demand.

## Packages

| Package | Role |
|---|---|
| `@elinpf/dsh-ops-access` | Credential registry core: `ctx.opsAccess` service, `access.yaml`, provider registration helper |
| `@elinpf/dsh-ops-access-k8s` / `-ceph` / `-ssh` | Credential providers: zod schemas, field processing, save-time content validation, capability probes |
| `@elinpf/dsh-ops-access-gate` | Access gate: per-session brokering, ro/rw tiers, grants, approval flow, audit log |
| `@elinpf/dsh-ops-tool-kubectl` / `-tool-ceph` / `-tool-ssh` | Model-facing shell tools; resolve a profile by name and build the command |
| `@elinpf/dsh-ops-shell-tool` | Shared consumer library (not a plugin): result shape, output schema, execute template, path scrubbing |
| `@elinpf/dsh-ops-tool-trace` | Investigation tree tool (`trace`) + tree doctrine |
| `@elinpf/dsh-ops-trace-ui` | Host-plane shell for the trace web panel and shared `trace` session projection |
| `@elinpf/dsh-ops-tool-environment` | Environment inventory: scanner core + `environment` tool (overview/show/refresh) |
| `@elinpf/dsh-ops-panel` | Session-scoped dialog panel seam (`ctx.opsPanels`) |
| `@elinpf/dsh-ops-prompts` | Prompt channel: methodology sections, reminders, bundled prompt-only skills |
| `@elinpf/dsh-ops-access-ui` | Browser half of the `@`-mention access-profile picker |

[`ops-preset.yml`](ops-preset.yml) is the reference agent-plane composition (the `ops` preset) that mounts these alongside upstream dsh tools.

## Architecture in brief

- **Two planes.** Model-facing rows (tools, prompt content) live in the preset plane; registries, projections, and web client carriers live in the host plane. A row belongs to exactly one plane.
- **Capability seam, three roles.** Credentials split into definition package (`ops-access` core), providers (one per kind), and consumers (the tools) — providers never depend on each other.
- **Model-visible ⟺ logged.** Anything that reaches a model request must be reconstructable from the session event log; tree state is folded from events by projections.
- **Secrets never pass through any service.** Profiles carry paths, not material. The gate's threat model is "prevent mistakes, not malice".

Design decisions live in [`docs/adr/`](docs/adr/), finalized specs in [`docs/specs/`](docs/specs/), and the domain glossary (Chinese) in [`CONTEXT.md`](CONTEXT.md).

## Installation

Install the packages your deployment needs and wire them into your agent preset following [`ops-preset.yml`](ops-preset.yml) — it shows the required groups, realms, and row ids:

```sh
npm install @elinpf/dsh-ops-access @elinpf/dsh-ops-access-k8s @elinpf/dsh-ops-access-ssh
```

The suite targets the `dsh-v0.1.0-rc` line of DeepSeek Harness and `@deepseek-ai/cordis` v4. Each plugin package ships a `cordis.patch.yml` (declared under `dsh.bundle.patch` in its package.json); web client halves (`*-ui`, `ops-panel`) additionally declare `dsh.client.platform: "web"`.

## Development

pnpm monorepo; day-to-day commands run per package:

```sh
pnpm install                # at repo root, once
cd packages/<pkg> && npm run build && npx vitest run
```

Whole-repo sweeps (what CI runs): `pnpm -r run build`, `pnpm -r run test` from the root.

## Versioning and release

All 15 packages share one version number (`fixed` group in changesets) and publish together. With any user-facing change, run `pnpm changeset` and commit the generated `.changeset/*.md`; merging the resulting "chore: version packages" PR on master publishes the suite to npm via GitHub Actions.

## Security notes

- Secret material never enters services, logs, errors, or model context — credential files are written once at registration time and referenced by path afterwards.
- Save-time validation (`validateContent`) rejects malformed credentials at write time with zero file I/O on failure.
- The access gate keeps an audit log of every grant and revocation. Same-UID in-process secrecy is explicitly out of scope.
