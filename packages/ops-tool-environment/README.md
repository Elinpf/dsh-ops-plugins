# @deepseek-ai/dsh-ops-tool-environment

Environment inventory for DeepSeek Harness ops mode — a read-only, fully deterministic scanner that maps the k8s clusters registered in `ops-access` into `~/.dsh-ops/environment.yaml`, plus the model-facing `environment` tool the agent reads it through (spec `docs/specs/0003-environment-inventory.md`).

## The `environment` tool

Four actions: `overview` (all clusters, compact: middleware counts by type, unknown count, stale flag, scan time), `show` (one cluster: middleware instances, unknown bucket, relation edges), `refresh` (re-scan every registered k8s cluster now), `help` (full usage — progressive disclosure; the system prompt carries only a one-line pointer).

- **Freshness** — reads re-scan when the inventory is missing or its oldest section is past the TTL (`ttlMinutes`, default 60); nothing scans at session start
- **Read-only credentials** — refresh resolves k8s profiles without an agent identity, so the access gate's broker falls back to the ro tier
- **Two mount rows** — realm topology splits the plugin: the tool entry (`.`) sits in the `ops-access-registry` group (needs `opsAccess`), the `./prompt` subpath plugin registers the one-line methodology section through `ops-prompts` and sits in the `ops-orchestration` group. Entry-local isolate realms are invisible across groups, so one row cannot see both services.

## What it does

For each registered k8s cluster, the scanner pulls workloads (deploy/sts/ds), Services, Ingresses, ConfigMaps, and Secret **metadata** from the k8s API via `kubectl`, classifies workloads against a middleware table, derives best-effort relation edges, and persists one section per cluster with a scan timestamp.

- **Deterministic** — same cluster, same bytes; zero LLM involvement
- **Freshness** — each section carries `scannedAt`; a failed refresh keeps the old section and marks it `stale: true`
- **Unknown bucket** — unrecognized workloads stay listed with name and image
- **Prometheus corroboration** — when a cluster has a discoverable Prometheus service (name contains `prometheus`, port 9090, `monitoring` namespace preferred), the scanner reads `/api/v1/targets` over a short-lived `kubectl port-forward` and attaches `monitoring: { up, down }` per workload. Any failure here degrades silently — the cluster section is still written and never marked stale for it
- **Anomaly detection** — two generic-semantics detectors per section: `cross-namespace-ref` (a workload references a Service in another namespace) and `service-no-backend` (a Service has a selector but zero ready Endpoints addresses — Endpoints being k8s' authoritative backend answer). overview lists them in one section; show annotates entries in place
- **User rules** — `~/.dsh-ops/environment-rules.yaml` appends/overrides classification rules

## Security discipline

- Secrets are fetched **metadata-only** (jsonpath of namespace/name) — `data` never enters the process
- The kubeconfig path is scrubbed from every error before it can reach the inventory, logs, or the model
- Only literal container env values are read; `valueFrom` contributes reference names only

## Module map

| Module | Role |
|---|---|
| `src/scanner.ts` | kubectl reads → `ClusterScan` (pure data, injectable exec, 30s timeout) |
| `src/classify.ts` | image/chart/label → middleware type; built-in table + user rules file |
| `src/relations.ts` | best-effort edges: `uses-service`, `fronts`, `uses-middleware`, `references-secret` |
| `src/anomalies.ts` | rule-based anomaly detectors: `cross-namespace-ref`, `service-no-backend` (endpoints-based) |
| `src/prometheus.ts` | Prometheus corroboration: service discovery, `kubectl port-forward` lifecycle (always reaped), targets parsing, workload matching |
| `src/inventory.ts` | `environment.yaml` persistence, read API, refresh + stale logic |
| `src/tool.ts` | the `environment` tool factory (actions, TTL gate, render); `createEnvironmentTool` takes injectable deps for tests |
| `src/doctrine.ts` | single source of the tool description, one-line prompt, and help text |
| `src/prompt.ts` | `./prompt` subpath plugin: registers the methodology line via `ops-prompts` |
| `src/index.ts` | tool plugin entry (name/inject/Config/apply) + scanner-core re-exports |

## Development

```sh
npm run build    # tsc → lib/
npm test         # vitest
```
