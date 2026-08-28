/**
 * The `environment` model tool — the preset-plane face of the inventory.
 *
 * Three working actions plus help:
 *
 * - `overview` — compact all-cluster summary (middleware counts by type,
 *   unknown count, stale flag, scan time).
 * - `show` — one cluster in detail: middleware instances, the unknown
 *   bucket, relation edges.
 * - `refresh` — re-scan every k8s profile in the ops-access registry.
 *
 * Freshness: overview/show call ensureFresh first — when the inventory is
 * missing or its oldest section is older than the configured TTL, a refresh
 * runs before answering. Nothing scans at session start; apply() only
 * registers the tool.
 *
 * Refresh resolves each k8s profile WITHOUT an agent identity: the access
 * gate's broker falls back to the ro tier for agent-less resolves, which is
 * exactly the read-only discipline the scanner wants. kubeconfig paths are
 * used to spawn kubectl and never surface in results — every error string
 * crossing into tool output is scrubbed.
 *
 * @module @deepseek-ai/dsh-ops-tool-environment
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OpsAccess } from '@deepseek-ai/dsh-ops-access'
import { readInventory, refreshInventory } from './inventory.js'
import { HELP_TEXT, TOOL_DESCRIPTION } from './doctrine.js'
import type { EnvironmentInventory, InventorySection, RefreshTarget } from './inventory.js'
import type { Anomaly, CephHints, MonitoringStatus, RelationEdge, ResourceRef } from './types.js'

const MONITORING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    up: { type: 'integer', required: true },
    down: { type: 'integer', required: true },
  },
} as const

const CEPH_NS_NAME_SCHEMA = { type: 'object', additionalProperties: false, properties: { namespace: { type: 'string', required: true }, name: { type: 'string', required: true } } } as const

/** rook-ceph footprint hints in show output (ticket 15). */
const CEPH_HINTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pools: { type: 'array', required: true, items: CEPH_NS_NAME_SCHEMA },
    clusters: { type: 'array', required: true, items: CEPH_NS_NAME_SCHEMA },
    toolsPod: CEPH_NS_NAME_SCHEMA,
  },
} as const

const RESOURCE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    namespace: { type: 'string', required: true },
    name: { type: 'string', required: true },
  },
} as const

const ANOMALY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    severity: { type: 'string', required: true },
    message: { type: 'string', required: true },
    ref: { ...RESOURCE_REF_SCHEMA, required: true },
    related: RESOURCE_REF_SCHEMA,
  },
} as const

// ── Config ───────────────────────────────────────────────────────────────────

export interface EnvironmentToolConfig {
  /** Inventory file path (default ~/.dsh-ops/environment.yaml). */
  inventoryFile: string
  /** User classification rules file (default ~/.dsh-ops/environment-rules.yaml). */
  rulesFile: string
  /** Sections older than this are re-scanned on the next read (default 60). */
  ttlMinutes: number
}

// ── Result shapes ────────────────────────────────────────────────────────────

export interface ClusterSummary {
  name: string
  scannedAt: string
  stale: boolean
  /** Middleware instance count. */
  middleware: number
  /** Unknown-bucket workload count. */
  unknown: number
  /** Prometheus-down target count across workloads (0 when unmonitored/healthy). */
  down: number
  /** Detected anomaly count. */
  anomalies: number
  /** Middleware type → instance count. */
  byType: Array<{ type: string, count: number }>
  /** CephBlockPool count when the scan found rook-ceph hints (ticket 15). */
  cephPools?: number
  lastError?: string
}

export interface UnknownWorkload {
  name: string
  namespace: string
  kind: string
  images: string[]
  monitoring?: MonitoringStatus
}

/**
 * Edge as shown to the model: same shape as RelationEdge but with a plain
 * string kind — the output schema cannot express the literal union, and
 * RelationEdge is assignable to it.
 */
export interface DisplayEdge {
  kind: string
  from: RelationEdge['from']
  to: RelationEdge['to']
  via: string
  targetType?: string
}

export interface ClusterDetail {
  name: string
  scannedAt: string
  stale: boolean
  lastError?: string
  /** The Prometheus service monitoring data came from, when discovered. */
  prometheusService?: string
  /** rook-ceph footprint hints (pools / cluster / tools pod), when found. */
  ceph?: CephHints
  middleware: InventorySection['middleware']
  unknown: UnknownWorkload[]
  edges: DisplayEdge[]
  anomalies: DisplayAnomaly[]
  counts: { services: number, ingresses: number, workloads: number }
}

/** Anomaly as shown to the model: Anomaly with plain-string kind/severity. */
export interface DisplayAnomaly {
  kind: string
  severity: string
  message: string
  ref: ResourceRef
  related?: ResourceRef
}

/** One anomaly line in overview output. */
export interface OverviewAnomaly {
  cluster: string
  kind: string
  severity: string
  message: string
}

export interface RefreshResultEntry {
  cluster: string
  status: 'ok' | 'stale' | 'skipped'
  middleware?: number
  unknown?: number
  /** Sanitized — never carries a credential path. */
  error?: string
}

export interface EnvironmentToolResult {
  action: string
  help?: string
  /** overview */
  totalClusters?: number
  clusters?: ClusterSummary[]
  /** overview: every detected anomaly across clusters, one line each. */
  anomalies?: OverviewAnomaly[]
  /** show */
  cluster?: ClusterDetail
  /** refresh */
  results?: RefreshResultEntry[]
  refreshedAt?: string
  /** Non-fatal note, e.g. auto-refresh skipped because ops-access is absent. */
  note?: string
  error?: string
}

// ── Injectable seams (tests) ─────────────────────────────────────────────────

export interface EnvironmentToolDeps {
  readInventory?: typeof readInventory
  refreshInventory?: typeof refreshInventory
  now?: () => number
}

// ── Shaping helpers ──────────────────────────────────────────────────────────

function summarize(name: string, section: InventorySection): ClusterSummary {
  const byTypeMap = new Map<string, number>()
  for (const m of section.middleware) byTypeMap.set(m.type, (byTypeMap.get(m.type) ?? 0) + 1)
  const summary: ClusterSummary = {
    name,
    scannedAt: section.scannedAt,
    stale: section.stale === true,
    middleware: section.middleware.length,
    unknown: section.workloads.filter(w => w.type === 'unknown').length,
    down: section.workloads.reduce((n, w) => n + (w.monitoring?.down ?? 0), 0),
    anomalies: (section.anomalies ?? []).length,
    byType: [...byTypeMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({ type, count })),
  }
  if (section.ceph !== undefined && section.ceph.pools.length > 0) summary.cephPools = section.ceph.pools.length
  if (section.lastError !== undefined) summary.lastError = section.lastError
  return summary
}

function detailOf(name: string, section: InventorySection): ClusterDetail {
  const detail: ClusterDetail = {
    name,
    scannedAt: section.scannedAt,
    stale: section.stale === true,
    middleware: section.middleware,
    unknown: section.workloads
      .filter(w => w.type === 'unknown')
      .map(w => {
        const u: UnknownWorkload = { name: w.name, namespace: w.namespace, kind: w.kind, images: w.images }
        if (w.monitoring !== undefined) u.monitoring = w.monitoring
        return u
      }),
    edges: section.edges,
    anomalies: section.anomalies ?? [], // absent in sections written before anomalies existed
    counts: {
      services: section.services.length,
      ingresses: section.ingresses.length,
      workloads: section.workloads.length,
    },
  }
  if (section.lastError !== undefined) detail.lastError = section.lastError
  if (section.prometheusService !== undefined) detail.prometheusService = section.prometheusService
  if (section.ceph !== undefined) detail.ceph = section.ceph
  return detail
}

// ── show filtering ──────────────────────────────────────────────────────────

export interface ShowFilter {
  namespace?: string
  name?: string
}

/**
 * Apply show's optional filters to a cluster detail. Both filters narrow the
 * middleware list and the unknown bucket; when a filter is given, edges are
 * kept only when their WORKLOAD endpoint survives the filter — that endpoint
 * is `from` for uses-service/uses-middleware/references-secret edges and `to`
 * for fronts edges (whose from is a Service). An investigation starts from a
 * workload and follows its outgoing edges, so edges whose workload fell out
 * of the filtered set are noise.
 */
export function filterDetail(detail: ClusterDetail, filter: ShowFilter): ClusterDetail {
  const ns = filter.namespace
  const name = filter.name?.toLowerCase()
  if (ns === undefined && name === undefined) return detail
  const matches = (namespace: string, workloadName: string): boolean =>
    (ns === undefined || namespace === ns)
    && (name === undefined || workloadName.toLowerCase().includes(name))
  const middleware = detail.middleware.filter(m => matches(m.namespace, m.workload))
  const unknown = detail.unknown.filter(u => matches(u.namespace, u.name))
  const kept = new Set([
    ...middleware.map(m => `${m.namespace}/${m.workload}`),
    ...unknown.map(u => `${u.namespace}/${u.name}`),
  ])
  const edges = detail.edges.filter(e => {
    const wl = e.kind === 'fronts' ? e.to : e.from
    return kept.has(`${wl.namespace}/${wl.name}`)
  })
  // Anomalies narrow with the lists: workload-subject anomalies follow the
  // workload filter; Service-subject anomalies survive when a surviving
  // middleware instance is fronted by that Service.
  const anomalies = detail.anomalies.filter(a => {
    if (a.ref.kind === 'Service') {
      return middleware.some(m => m.namespace === a.ref.namespace && m.serviceEntries.includes(a.ref.name))
    }
    return matches(a.ref.namespace, a.ref.name)
  })
  return { ...detail, middleware, unknown, edges, anomalies }
}

// ── The tool factory ─────────────────────────────────────────────────────────

export function createEnvironmentTool(
  ctx: Context,
  config: EnvironmentToolConfig,
  deps: EnvironmentToolDeps = {},
) {
  const read = deps.readInventory ?? readInventory
  const refreshAll = deps.refreshInventory ?? refreshInventory
  const now = deps.now ?? (() => Date.now())
  const ttlMs = config.ttlMinutes * 60_000

  /** Resolve opsAccess per call — never cached, never a static inject. */
  const getOpsAccess = (): OpsAccess | undefined => ctx.get('opsAccess') as OpsAccess | undefined

  /**
   * Collect scan targets from the registry: every k8s entry whose ro tier
   * resolves. Entries that fail resolve are reported as skipped, with the
   * kubeconfig path scrubbed out of the reason (defense in depth — the
   * registry's own errors never carry it).
   */
  async function collectTargets(opsAccess: OpsAccess): Promise<{ targets: RefreshTarget[], skipped: RefreshResultEntry[] }> {
    const entries = await opsAccess.listAll()
    const targets: RefreshTarget[] = []
    const skipped: RefreshResultEntry[] = []
    for (const entry of entries.filter(e => e.kind === 'k8s')) {
      try {
        // No agent identity on purpose: the gate's broker falls back to ro
        // for agent-less resolves — scanning is read-only by discipline.
        const profile = await opsAccess.resolve('k8s', entry.name)
        const kubeconfigPath = profile.fields.kubeconfigPath
        if (typeof kubeconfigPath === 'string' && kubeconfigPath !== '') {
          targets.push({ cluster: entry.name, kubeconfigPath })
        } else {
          skipped.push({ cluster: entry.name, status: 'skipped', error: 'profile has no kubeconfigPath field' })
        }
      } catch (err) {
        skipped.push({ cluster: entry.name, status: 'skipped', error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { targets, skipped }
  }

  /** Re-scan all registered k8s clusters and shape the per-cluster report. */
  async function doRefresh(opsAccess: OpsAccess): Promise<EnvironmentToolResult> {
    const { targets, skipped } = await collectTargets(opsAccess)
    const inventory = await refreshAll(targets, {
      file: config.inventoryFile,
      userRulesFile: config.rulesFile,
    })
    const results: RefreshResultEntry[] = [...skipped]
    for (const target of targets) {
      const section = inventory.clusters[target.cluster]
      if (!section) {
        results.push({ cluster: target.cluster, status: 'stale', error: 'scan produced no section' })
        continue
      }
      const summary = summarize(target.cluster, section)
      const entry: RefreshResultEntry = {
        cluster: target.cluster,
        status: summary.stale ? 'stale' : 'ok',
        middleware: summary.middleware,
        unknown: summary.unknown,
      }
      if (summary.lastError !== undefined) entry.error = summary.lastError
      results.push(entry)
    }
    results.sort((a, b) => a.cluster.localeCompare(b.cluster))
    return { action: 'refresh', results, refreshedAt: new Date(now()).toISOString() }
  }

  /**
   * TTL gate before reads: refresh when the inventory is missing or its
   * oldest section is past the TTL. Best-effort — without opsAccess (or on
   * total scan failure) the caller answers from whatever cache exists.
   */
  async function ensureFresh(): Promise<string | undefined> {
    const inventory = await read(config.inventoryFile)
    const sections = Object.values(inventory?.clusters ?? {})
    const oldest = sections.reduce<number>((min, s) => {
      const t = Date.parse(s.scannedAt)
      return Number.isNaN(t) ? 0 : Math.min(min, t)
    }, Number.POSITIVE_INFINITY)
    const expired = oldest === Number.POSITIVE_INFINITY || now() - oldest > ttlMs
    if (!expired) return undefined
    const opsAccess = getOpsAccess()
    if (!opsAccess) return 'inventory is expired or missing, but the ops-access service is unavailable — answering from cache'
    await doRefresh(opsAccess)
    return undefined
  }

  return defineTool({
    name: 'environment',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string', required: true, enum: ['overview', 'show', 'refresh', 'help'],
        description: 'overview: all clusters, compact. show: one cluster, details + edges (requires cluster). refresh: re-scan now. help: full usage.',
      },
      cluster: { type: 'string', description: 'Cluster name (required for show). Use overview or list_access to see names.' },
      namespace: { type: 'string', description: 'show only: keep middleware/unknown workloads in this namespace (exact match).' },
      name: { type: 'string', description: 'show only: keep middleware/unknown workloads whose name contains this substring (case-insensitive). Combined with namespace as AND.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          help: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
          totalClusters: { type: 'integer' },
          refreshedAt: { type: 'string' },
          anomalies: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cluster: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          clusters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                scannedAt: { type: 'string', required: true },
                stale: { type: 'boolean', required: true },
                middleware: { type: 'integer', required: true },
                unknown: { type: 'integer', required: true },
                down: { type: 'integer', required: true },
                anomalies: { type: 'integer', required: true },
                byType: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      type: { type: 'string', required: true },
                      count: { type: 'integer', required: true },
                    },
                  },
                },
                cephPools: { type: 'integer' },
                lastError: { type: 'string' },
              },
            },
          },
          cluster: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              scannedAt: { type: 'string', required: true },
              stale: { type: 'boolean', required: true },
              lastError: { type: 'string' },
              prometheusService: { type: 'string' },
              ceph: CEPH_HINTS_SCHEMA,
              counts: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  services: { type: 'integer', required: true },
                  ingresses: { type: 'integer', required: true },
                  workloads: { type: 'integer', required: true },
                },
              },
              middleware: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    type: { type: 'string', required: true },
                    namespace: { type: 'string', required: true },
                    workload: { type: 'string', required: true },
                    workloadKind: { type: 'string', required: true },
                    images: { type: 'array', required: true, items: { type: 'string' } },
                    serviceEntries: { type: 'array', required: true, items: { type: 'string' } },
                    monitoring: MONITORING_SCHEMA,
                  },
                },
              },
              unknown: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    namespace: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    images: { type: 'array', required: true, items: { type: 'string' } },
                    monitoring: MONITORING_SCHEMA,
                  },
                },
              },
              edges: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true },
                    from: {
                      type: 'object', required: true, additionalProperties: false,
                      properties: {
                        kind: { type: 'string', required: true },
                        namespace: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                      },
                    },
                    to: {
                      type: 'object', required: true, additionalProperties: false,
                      properties: {
                        kind: { type: 'string', required: true },
                        namespace: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                      },
                    },
                    via: { type: 'string', required: true },
                    targetType: { type: 'string' },
                  },
                },
              },
              anomalies: {
                type: 'array',
                required: true,
                items: ANOMALY_SCHEMA,
              },
            },
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cluster: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['ok', 'stale', 'skipped'] },
                middleware: { type: 'integer' },
                unknown: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text' as const, text: renderResult(value, args as { namespace?: string, name?: string }) }],
    },
    async execute(args: { action: string, cluster?: string, namespace?: string, name?: string }): Promise<EnvironmentToolResult> {
      try {
        switch (args.action) {
          case 'help':
            return { action: 'help', help: HELP_TEXT }

          case 'overview': {
            const note = await ensureFresh()
            const inventory = await read(config.inventoryFile)
            const clusters = Object.entries(inventory?.clusters ?? {})
              .map(([name, section]) => summarize(name, section))
            const anomalies: OverviewAnomaly[] = []
            for (const [name, section] of Object.entries(inventory?.clusters ?? {})) {
              for (const a of section.anomalies ?? []) {
                anomalies.push({ cluster: name, kind: a.kind, severity: a.severity, message: a.message })
              }
            }
            const result: EnvironmentToolResult = {
              action: 'overview',
              totalClusters: clusters.length,
              clusters,
            }
            if (anomalies.length > 0) result.anomalies = anomalies
            if (note !== undefined) result.note = note
            if (clusters.length === 0) {
              result.note = (result.note ? result.note + '; ' : '')
                + 'inventory is empty — no k8s clusters registered in ops-access, or every scan has failed so far'
            }
            return result
          }

          case 'show': {
            if (!args.cluster) return { action: 'show', error: 'show requires the cluster parameter' }
            const note = await ensureFresh()
            const inventory = await read(config.inventoryFile)
            const section = inventory?.clusters[args.cluster]
            if (!section) {
              const known = Object.keys(inventory?.clusters ?? {}).sort()
              return {
                action: 'show',
                error: `unknown cluster "${args.cluster}" in the inventory` + (known.length > 0 ? `. Known: ${known.join(', ')}` : ' — the inventory is empty'),
              }
            }
            const result: EnvironmentToolResult = {
              action: 'show',
              cluster: filterDetail(detailOf(args.cluster, section), { namespace: args.namespace, name: args.name }),
            }
            if (note !== undefined) result.note = note
            return result
          }

          case 'refresh': {
            const opsAccess = getOpsAccess()
            if (!opsAccess) {
              return { action: 'refresh', error: 'ops-access service unavailable — is the ops-access plugin mounted in this preset?' }
            }
            return await doRefresh(opsAccess)
          }

          default:
            return { action: args.action, error: `unknown action "${args.action}" — use overview, show, refresh, or help` }
        }
      } catch (err) {
        // refreshInventory folds per-cluster failures into sections and
        // collectTargets catches resolve errors, so reaching here means an
        // unexpected bug — no credential path flows through this message.
        const message = err instanceof Error ? err.message : String(err)
        return { action: args.action, error: message }
      }
    },
  })
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderMonitoring(m: MonitoringStatus | undefined): string {
  if (m === undefined) return ''
  return m.down > 0 ? ` · prometheus: up ${m.up} [DOWN ${m.down}]` : ` · prometheus: up ${m.up}`
}

function renderResult(value: EnvironmentToolResult, args: { namespace?: string, name?: string } = {}): string {
  if (value.help !== undefined) return value.help
  const lines: string[] = []
  if (value.error !== undefined) lines.push(`[error] ${value.error}`)
  if (value.note !== undefined) lines.push(`[note] ${value.note}`)

  if (value.clusters !== undefined) {
    lines.push(`Environment inventory — ${value.totalClusters ?? 0} cluster(s):`)
    for (const c of value.clusters) {
      const types = c.byType.map(t => `${t.type}×${t.count}`).join(', ') || 'none'
      const stale = c.stale ? ' [STALE]' : ''
      const down = c.down > 0 ? ` · PROMETHEUS DOWN: ${c.down}` : ''
      const anomalies = c.anomalies > 0 ? ` · ${c.anomalies} anomalies` : ''
      const ceph = (c.cephPools ?? 0) > 0 ? ` · ceph pools: ${c.cephPools}` : ''
      lines.push(`- ${c.name}: ${c.middleware} middleware (${types}), ${c.unknown} unknown, scanned ${c.scannedAt}${stale}${down}${anomalies}${ceph}`)
      if (c.lastError !== undefined) lines.push(`  last error: ${c.lastError}`)
    }
    if (value.anomalies !== undefined && value.anomalies.length > 0) {
      lines.push('Anomalies:')
      for (const a of value.anomalies) {
        lines.push(`- [${a.severity}] ${a.cluster}: ${a.message}`)
      }
    }
  }

  if (value.cluster !== undefined) {
    const c = value.cluster
    // In-place annotation: workload-subject anomalies mark their workload
    // line; Service-subject anomalies mark the middleware they front.
    const workloadNotes = new Map<string, string[]>()
    const serviceNotes = new Map<string, string[]>()
    for (const a of c.anomalies) {
      const map = a.ref.kind === 'Service' ? serviceNotes : workloadNotes
      const key = `${a.ref.namespace}/${a.ref.name}`
      map.set(key, [...(map.get(key) ?? []), a.message])
    }
    const notesFor = (namespace: string, name: string, serviceEntries: string[]): string => {
      const notes = [...(workloadNotes.get(`${namespace}/${name}`) ?? [])]
      for (const svc of serviceEntries) notes.push(...(serviceNotes.get(`${namespace}/${svc}`) ?? []))
      return notes.map(n => ` · [!] ${n}`).join('')
    }
    lines.push(`Cluster ${c.name} — scanned ${c.scannedAt}${c.stale ? ' [STALE]' : ''}`
      + ` (${c.counts.workloads} workloads, ${c.counts.services} services, ${c.counts.ingresses} ingresses)`
      + (c.prometheusService !== undefined ? ` · prometheus: ${c.prometheusService}` : ''))
    const filterBits = [
      args.namespace !== undefined ? `namespace=${args.namespace}` : undefined,
      args.name !== undefined ? `name~=${args.name}` : undefined,
    ].filter(Boolean)
    if (filterBits.length > 0) lines.push(`filtered by ${filterBits.join(' AND ')} (lists below are the matching subset)`)
    if (c.lastError !== undefined) lines.push(`last error: ${c.lastError}`)
    // rook-ceph hints: pool names are the ceph tool's -p arguments; the
    // tools pod location (or its absence) saves a live discovery step.
    if (c.ceph !== undefined) {
      const pools = c.ceph.pools.map(p => p.name).join(', ')
      const clusters = c.ceph.clusters.map(cl => `${cl.namespace}/${cl.name}`).join(', ')
      lines.push('ceph: ' + (c.ceph.pools.length > 0 ? `pools ${pools}` : 'no CephBlockPool CRs found')
        + (clusters !== '' ? ` · cluster ${clusters}` : '')
        + (c.ceph.toolsPod !== undefined ? ` · tools pod ${c.ceph.toolsPod.namespace}/${c.ceph.toolsPod.name}` : ' · no rook-ceph-tools pod deployed'))
    }
    lines.push('Middleware:')
    for (const m of c.middleware) {
      lines.push(`- ${m.type} · ${m.namespace}/${m.workload} (${m.workloadKind}) · svc: ${m.serviceEntries.join(', ') || 'none'} · ${m.images.join(', ')}${renderMonitoring(m.monitoring)}${notesFor(m.namespace, m.workload, m.serviceEntries)}`)
    }
    if (c.middleware.length === 0) lines.push('- (none recognized)')
    lines.push('Unknown workloads:')
    for (const u of c.unknown) {
      lines.push(`- ${u.namespace}/${u.name} (${u.kind}) · ${u.images.join(', ')}${renderMonitoring(u.monitoring)}${notesFor(u.namespace, u.name, [])}`)
    }
    if (c.unknown.length === 0) lines.push('- (none)')
    lines.push('Relations:')
    for (const e of c.edges) {
      lines.push(`- [${e.kind}] ${e.from.namespace}/${e.from.name} → ${e.to.namespace}/${e.to.name}`
        + (e.targetType !== undefined ? ` (${e.targetType})` : '') + ` via ${e.via}`)
    }
    if (c.edges.length === 0) lines.push('- (none)')
  }

  if (value.results !== undefined) {
    lines.push(`Refresh finished at ${value.refreshedAt ?? '?'}:`)
    for (const r of value.results) {
      if (r.status === 'ok') {
        lines.push(`- ${r.cluster}: ok (${r.middleware ?? 0} middleware, ${r.unknown ?? 0} unknown)`)
      } else if (r.status === 'stale') {
        lines.push(`- ${r.cluster}: FAILED — kept previous data (stale)${r.error !== undefined ? ` · ${r.error}` : ''}`)
      } else {
        lines.push(`- ${r.cluster}: skipped${r.error !== undefined ? ` · ${r.error}` : ''}`)
      }
    }
  }

  return lines.join('\n')
}
