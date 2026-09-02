# AGENTS.md

Guidance for AI coding agents working in this repository: a pnpm monorepo of ops-scenario plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), where everything is a Cordis plugin.

This repo lives inside a larger workspace (`../`) together with a test instance (`../.dsh-target`) and the dsh-plugin-forge skill repo — see the workspace-level `../AGENTS.md` for that layout. This file covers this repo only.

## Overview

All 16 packages under `packages/` share one version number (changesets `fixed` group) and publish together as a lockstep suite ("插件集 vX"). npm names are `@elinpf/dsh-ops-*`, plus the single deployment package `@elinpf/dsh-ops`.

**`CONTEXT.md` is the domain glossary and the single source of truth for shared vocabulary** (in Chinese). If a code change alters the meaning of a term defined there, update `CONTEXT.md` in the same change. Design decisions and finalized specs live in `docs/adr/` and `docs/specs/`; planned work is broken into tickets under `.scratch/<feature>/issues/`.

The repo root carries a user-facing README trio (`README.md` / `README.zh.md` / `README.i18n.yaml`) — installation, deployment, and uninstall from the user's perspective. Keep it in sync when the composition or package names change; this file stays agent-facing and does not duplicate it.

## Packages

- `ops/` (`@elinpf/dsh-ops`) — the single deployment package users install: depends on every granular package, carries the host-plane rows in its `cordis.patch.yml`, ships the `ops` agent preset under `presets/ops/`, and provides the `dsh-ops` bin (`preset install|remove`) that materializes the preset into the agents home. It is never mounted as a plugin row itself.
- `ops-access/` — the credential capability seam, split by the three-role rule:
  - `core` (`@elinpf/dsh-ops-access`) — owns the YAML credential registry (default `~/.dsh-ops/access.yaml`) and the `ctx.opsAccess` service; providers register via its `registerAccessProvider(ctx, provider)` helper (never hand-write `ctx.inject` for sibling services — it deadlocks the loader).
  - `k8s` / `ceph` / `ssh` — one provider per credential kind: only a zod schema plus field processing (e.g. `~` expansion).
- `ops-tool-kubectl` / `ops-tool-ceph` / `ops-tool-ssh` — consumer tools; resolve a profile by name and build the shell command. They only supply four identity pieces: tool name, resolved kind, profile-arg name, `buildCommand`. npm names are `@elinpf/dsh-ops-tool-{kubectl,ceph,ssh}` — the kubectl package was renamed from `@elinpf/dsh-ops-kubectl` in 0.1.1 (old name deprecated on npm); directory names were never affected.
- `ops-shell-tool` — pure library (not a plugin); the single source of the shared consumer machinery: standard result shape `{ exitCode, stdout, stderr, command, error? }`, output schema, render, and the resolve-per-call execute template (30 s timeout, signal deaths normalized to exitCode -1).
- `ops-tool-trace` — investigation-tree tool (preset plane), replacing flat todo lists with a tree of goal/milestones/steps. Tree doctrine text has its single source in `src/doctrine.ts`; `src/tree-layout.ts` is shared with the web panel via the `/tree-layout` subpath export.
- `ops-tool-environment` — environment inventory (preset plane): the deterministic scanner core (scan → classify → relations → Prometheus corroboration via short-lived `kubectl port-forward` → `~/.dsh-ops/environment.yaml`) plus the `environment` tool (overview/show/refresh, TTL auto-refresh). Realm topology splits it into two preset rows: the tool entry mounts in `ops-access-registry` (needs `opsAccess`), the `./prompt` subpath plugin registers the one-line methodology section and mounts in `ops-orchestration` (needs `opsPrompts`) — entry-local isolate realms are invisible across groups.
- `ops-trace-ui` — host-plane thin shell: registers the shared `trace` session projection and ships the web panel client bundle. Registers no tools and touches no prompts.
- `ops-prompts` — prompt channel plugin: registers methodology sections (static system-prompt text) and reminders (pre-step check functions that inject ephemeral prompts). Also ships the repo's prompt-only skills into dsh's **native skill subsystem** via a bundled provider (`ops-prompts-bundled`, `src/skills.ts`): Markdown files in the package's `skills/` dir with native frontmatter (`name`/`description` required, `whenToUse` optional) become catalog candidates; bodies are pulled on demand through the `skill` tool. A prompt-only skill is a text file, never its own package (see CONTEXT.md「ops 专属 skill」). Beyond the bundled skills it carries no business content.
- `ops-access-ui` — browser half of the `@`-mention access-profile picker; its host row exists only for client-bundle discovery.

`ops-preset.yml` at the repo root is the agent-plane composition (the `ops` preset) that mounts these plugins alongside upstream dsh tools.

## Build and test

The root `package.json` is private and exists only for CI/release orchestration (changesets + `pnpm -r`); day-to-day commands run per package:

```sh
cd packages/<pkg>          # or packages/ops-access/<core|k8s|ceph|ssh>
pnpm install               # at repo root, once / after dependency changes
npm run build              # tsc → lib/  (plugins load lib/, NOT src/ — unbuilt changes do nothing)
npm run typecheck          # tsc --noEmit
npx vitest run             # or: npm test
```

Whole-repo sweeps (what CI runs): `pnpm -r run build` and `pnpm -r run test` from the root.

`ops-trace-ui` and `ops-access-ui` additionally run `node esbuild.config.mjs` after `tsc` to produce the web client bundle (`lib/client.js`).

## Dependency rules (workspace protocol)

- Runtime cross-package dependencies in `dependencies` use `workspace:^`; dev-only links in `devDependencies` use `workspace:*`. pnpm rewrites both to real versions at publish (`workspace:^` → `^x.y.z`). A bare semver range in `dependencies` pointing at an unpublished sibling will 404 against the npm registry.
- Type-only references (`import type`) are safe as bare semver in `peerDependencies` + a `workspace:*` link in `devDependencies` (peers are not installed).
- `pnpm-workspace.yaml` sets `nodeLinker: hoisted` and `autoInstallPeers: false` to match the dsh profile's linker expectations — do not change these casually.

## Plugin conventions

- Plugins follow the dsh two forms (function plugin with `name`/`inject`/`Config`/`apply` named exports and **no default export**, or a `Service` subclass). Every contribution is registered as an effect so fiber disposal/HMR unloads it.
- Each plugin package ships a `cordis.patch.yml` and declares it under `dsh.bundle.patch` in package.json; web client halves also declare `dsh.client.platform: "web"`.
- Config uses schemastery; credential field schemas use zod (v4) in providers.
- A row belongs to exactly one plane: host plane (registries, projections, web client carriers) vs preset plane (model-facing tools, prompt content). Services shared by a group of rows sit behind an `isolate` realm in the preset file; **a cordis group id must never equal a child id** (infinite loop in the loader's parent walk).
- Do not runtime-import dsh packages that keep module-private state from these external packages — monorepo path resolution yields a second module instance and state silently diverges (e.g. remote-route markers). Cross-process routes go through plain HTTP (`webServer.register` + `fetch`).
- Model-visible ⟺ logged: anything reaching a model request must be reconstructable from the session event log; tree state is folded from events by projections, owned per session by `SessionForestStore`.

## Verification workflow (from CONTEXT.md — follow it)

1. Edit code in `packages/<pkg>`.
2. `npm run build` in that package.
3. `npx vitest run` in that package.
4. `systemctl restart dsh-ops` to restart the test instance.
5. Verify real behavior in the web UI at `http://127.0.0.1:3082` (reminders firing, tree rendering, credential resolution) — unit tests cannot substitute for a real session.

The test instance lives at `../../.dsh-target` (profile `dev-target`), which depends on every plugin via absolute `link:` entries and composes them through `dsh.profile.bundles` in its package.json plus `cordis.patch.yml` (default preset: `ops`; the upstream `session-reference` row is disabled there so the ops-access `@` source takes its slot).

## Documentation conventions

- Domain glossary (`CONTEXT.md`), ADRs, and specs are written in **Chinese**; code comments, JSDoc, and package READMEs are in **English**, with bilingual README sets (`README.md` + `README.zh.md` + `README.i18n.yaml`) where present.
- Prompt/methodology text follows progressive disclosure: only a few core lines live in the system prompt; full docs are pulled on demand (e.g. `trace` action `help`, `list_access` with `help: true`).

## Security considerations

- Secret material never passes through any service: profiles carry only paths and connection parameters, so logs, errors, and model context cannot contain secrets. `list_access` output omits even the fields — names and descriptions only.
- The registry file is re-read and re-validated on every resolve (no caching) — edits take effect without restart.
- The access-gate (`packages/ops-access/gate`, credential brokering, ro/rw tiers, per-session grants, audit log) is **implemented and wired into the ops preset** (inside the `ops-access-registry` realm, alongside its `opsAccessGate` isolate symbol); see `docs/adr/0001-access-gate.md` and `docs/specs/0001-access-gate.md` before touching authorization. Its threat model is "prevent mistakes, not malice" — same-UID in-process secrecy is explicitly out of scope.

## Release (changesets, fixed lockstep)

All 16 packages share one version number (`fixed` group in `.changeset/config.json`) — the suite ships as "插件集 vX". Flow:

1. With any user-facing change, run `pnpm changeset` and commit the generated `.changeset/*.md` file.
2. On push to `master`, `.github/workflows/release.yml` (changesets/action) opens or updates a "chore: version packages" PR.
3. Merging that PR bumps every package together, generates CHANGELOGs, and publishes all packages to npm in topological order via `pnpm release`.

Requires the `NPM_TOKEN` secret (a granular token with **Read and write on the `@elinpf` scope AND "bypass 2FA" enabled** — a granular token without the 2FA bypass gets 403 on publish). `.github/workflows/check.yml` runs build+test on every push/PR.

Operational facts about this pipeline (all verified 2026-09-02, 0.1.0/0.1.1 releases):

- The release workflow must export the token as **`NODE_AUTH_TOKEN`** (it also sets `NPM_TOKEN`, which nothing reads): `setup-node`'s `registry-url` writes an `.npmrc` keyed on `NODE_AUTH_TOKEN`, and pnpm/npm only honor that name.
- The repo setting **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"** must stay enabled, or the changesets action fails with "GitHub Actions is not permitted to create or approve pull requests" when opening the version PR.
- A bypass-2FA granular token may **publish and deprecate but not unpublish** — cleanup of accidentally published packages needs a web login or a classic token.
- A brand-new npm package's tarball is fetchable immediately, but its metadata document 404s for several minutes (registry read-path lag) — do not re-publish or diagnose a 404 on a fresh package as failure.
- Merging the version PR deletes `changeset-release/master` mid-run and kills the PR-branch `check` run (failure with no jobs/logs) — benign; the push-side `check` on master is the real verdict.

## General notes

- Never run `git commit`/`push`/`reset`/`rebase` unless explicitly asked.
- The dominant working language for domain discussion is Chinese (see `CONTEXT.md`); code, identifiers, and most code comments stay in English. Match the surrounding file when editing.
