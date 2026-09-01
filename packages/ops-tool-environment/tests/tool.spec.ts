/**
 * environment tool spec: drives createEnvironmentTool through a mock ctx,
 * covering the four actions, the TTL gate, the ro-only resolve discipline,
 * and the guarantee that no kubeconfig path reaches tool output.
 */

import { describe, expect, it } from 'vitest'
import { createEnvironmentTool, filterDetail } from '../src/tool.js'
import type { ClusterDetail, EnvironmentToolDeps } from '../src/tool.js'
import type { EnvironmentInventory, InventorySection } from '../src/inventory.js'
import { HELP_TEXT } from '../src/doctrine.js'

const NOW = Date.parse('2026-08-27T12:00:00Z')
const KUBECONFIG = '/home/tester/.dsh-ops/credentials/k8s/test/ro/kubeconfig'

function section(overrides: Partial<InventorySection> = {}): InventorySection {
  return {
    scannedAt: '2026-08-27T11:30:00.000Z', // 30m old — fresh under the 60m TTL
    middleware: [
      {
        type: 'postgres', namespace: 'acme', workload: 'postgres',
        workloadKind: 'StatefulSet', images: ['registry.example.com/middleware/postgres:16.2'],
        serviceEntries: ['postgres'],
      },
    ],
    workloads: [
      {
        kind: 'Deployment', namespace: 'acme', name: 'user-service',
        images: ['registry.example.com/acme/user-service:1.4.2'],
        labels: {}, podLabels: { app: 'user-service' }, env: {},
        configMapRefs: ['acme-config'], secretRefs: ['acme-secret'], type: 'unknown',
      },
    ],
    services: [],
    ingresses: [],
    anomalies: [],
    edges: [
      {
        kind: 'uses-middleware',
        from: { kind: 'Deployment', namespace: 'acme', name: 'user-service' },
        to: { kind: 'StatefulSet', namespace: 'acme', name: 'postgres' },
        via: 'configmap:acme-config:PG_HOST',
        targetType: 'postgres',
      },
    ],
    ...overrides,
  }
}

function inventory(clusters: Record<string, InventorySection>): EnvironmentInventory {
  return { version: 1, clusters }
}

interface SetupOpts {
  inventory?: EnvironmentInventory | null
  k8sEntries?: Array<{ name: string, roOk?: boolean }>
  resolveError?: string
  withOpsAccess?: boolean
  deps?: EnvironmentToolDeps
  ttlMinutes?: number
}

function setup(opts: SetupOpts = {}) {
  const calls = { read: 0, refresh: 0, resolve: 0 }
  let stored = opts.inventory === undefined ? inventory({ 'test': section() }) : opts.inventory
  const refreshTargets: Array<{ cluster: string, kubeconfigPath: string }> = []

  const deps: EnvironmentToolDeps = {
    now: () => NOW,
    readInventory: async () => {
      calls.read++
      return stored
    },
    refreshInventory: async (targets, _opts) => {
      calls.refresh++
      refreshTargets.push(...targets)
      // A failing kubeconfig path marks its section stale, like the real one.
      const clusters: Record<string, InventorySection> = { ...(stored?.clusters ?? {}) }
      for (const t of targets) {
        clusters[t.cluster] = t.kubeconfigPath.includes('broken')
          ? { ...(clusters[t.cluster] ?? section()), stale: true, lastError: `cannot connect: <kubeconfig>` }
          : section({ scannedAt: new Date(NOW).toISOString() })
      }
      stored = { version: 1, clusters }
      return stored
    },
    ...opts.deps,
  }

  const opsAccess = {
    listAll: async () => (opts.k8sEntries ?? [{ name: 'test' }]).map(e => ({
      kind: 'k8s', name: e.name, envelope: {},
      tiers: { ro: { ok: e.roOk ?? true }, rw: { ok: false } },
    })),
    resolve: async (kind: string, name: string, agent?: unknown) => {
      calls.resolve++
      if (agent !== undefined) throw new Error('resolve must be agent-less')
      if (opts.resolveError) throw new Error(opts.resolveError)
      return { kind, name, tier: 'ro' as const, fields: { kubeconfigPath: name === 'broken' ? '/x/broken/kubeconfig' : KUBECONFIG } }
    },
  }

  const tools: any[] = []
  const ctx: any = {
    get: (key: string) => key === 'opsAccess' && opts.withOpsAccess !== false ? opsAccess : undefined,
    tools: { register: (t: any) => { tools.push(t); return () => {} } },
  }

  const tool = createEnvironmentTool(ctx, {
    inventoryFile: '/tmp/test-inventory.yaml',
    rulesFile: '/nonexistent/environment-rules.yaml',
    ttlMinutes: opts.ttlMinutes ?? 60,
  }, deps)
  return { tool, calls, refreshTargets, getStored: () => stored }
}

const exec = () => ({ signal: new AbortController().signal })

describe('environment tool', () => {
  it('exposes overview/show/refresh/help with an optional cluster param', () => {
    const { tool } = setup()
    expect(tool.name).toBe('environment')
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['action', 'cluster', 'name', 'namespace'])
    expect([...tool.parameters.required]).toEqual(['action'])
    expect(tool.parameters.properties.action.enum).toEqual(['overview', 'show', 'refresh', 'help'])
  })

  it('help returns the full usage doc without touching inventory or opsAccess', async () => {
    const { tool, calls } = setup({ withOpsAccess: false })
    const value = await tool.execute({ action: 'help' }, exec())
    expect(value.help).toBe(HELP_TEXT)
    expect(calls.read).toBe(0)
    expect(calls.refresh).toBe(0)
    expect(calls.resolve).toBe(0)
  })

  it('overview summarizes a fresh inventory without refreshing', async () => {
    const { tool, calls } = setup()
    const value = await tool.execute({ action: 'overview' }, exec())
    expect(calls.refresh).toBe(0)
    expect(value.totalClusters).toBe(1)
    expect(value.clusters[0]).toMatchObject({
      name: 'test', stale: false, middleware: 1, unknown: 1,
      byType: [{ type: 'postgres', count: 1 }],
    })
  })

  it('show returns middleware, unknown bucket, and edges for a known cluster', async () => {
    const { tool } = setup()
    const value = await tool.execute({ action: 'show', cluster: 'test' }, exec())
    expect(value.cluster.name).toBe('test')
    expect(value.cluster.middleware[0]).toMatchObject({ type: 'postgres', serviceEntries: ['postgres'] })
    expect(value.cluster.unknown[0]).toMatchObject({ name: 'user-service', namespace: 'acme' })
    expect(value.cluster.edges[0]).toMatchObject({ kind: 'uses-middleware', targetType: 'postgres' })
  })

  it('show without cluster is an error; unknown cluster lists what is known', async () => {
    const { tool } = setup()
    const missing = await tool.execute({ action: 'show' }, exec())
    expect(missing.error).toContain('requires the cluster parameter')
    const unknown = await tool.execute({ action: 'show', cluster: 'nope' }, exec())
    expect(unknown.error).toContain('unknown cluster "nope"')
    expect(unknown.error).toContain('test')
  })
})

describe('TTL gate', () => {
  it('missing inventory triggers a refresh before answering', async () => {
    const { tool, calls } = setup({ inventory: null })
    const value = await tool.execute({ action: 'overview' }, exec())
    expect(calls.refresh).toBe(1)
    expect(value.totalClusters).toBe(1) // refreshed sections answer the read
  })

  it('a section older than the TTL triggers a refresh', async () => {
    const { tool, calls } = setup({
      inventory: inventory({ 'test': section({ scannedAt: '2026-08-27T10:00:00.000Z' }) }), // 2h old
    })
    await tool.execute({ action: 'overview' }, exec())
    expect(calls.refresh).toBe(1)
  })

  it('a stale-marked but young section does NOT trigger a refresh', async () => {
    const { tool, calls } = setup({
      inventory: inventory({ 'test': section({ stale: true, lastError: 'boom' }) }),
    })
    const value = await tool.execute({ action: 'overview' }, exec())
    expect(calls.refresh).toBe(0)
    expect(value.clusters[0].stale).toBe(true)
  })

  it('without opsAccess an expired inventory answers from cache with a note', async () => {
    const { tool, calls } = setup({ inventory: null, withOpsAccess: false })
    const value = await tool.execute({ action: 'overview' }, exec())
    expect(calls.refresh).toBe(0)
    expect(value.note).toContain('ops-access service is unavailable')
    expect(value.totalClusters).toBe(0)
  })
})

describe('refresh action', () => {
  it('resolves every k8s entry agent-less (broker falls back to ro) and reports per cluster', async () => {
    const { tool, calls, refreshTargets } = setup({
      k8sEntries: [{ name: 'test' }, { name: 'broken' }],
    })
    const value = await tool.execute({ action: 'refresh' }, exec())
    expect(calls.resolve).toBe(2)
    expect(refreshTargets).toEqual([
      { cluster: 'test', kubeconfigPath: KUBECONFIG },
      { cluster: 'broken', kubeconfigPath: '/x/broken/kubeconfig' },
    ])
    const byCluster = Object.fromEntries(value.results.map((r: any) => [r.cluster, r]))
    expect(byCluster['test']).toMatchObject({ status: 'ok', middleware: 1, unknown: 1 })
    expect(byCluster['broken']).toMatchObject({ status: 'stale' })
  })

  it('a resolve failure skips the cluster with a reason', async () => {
    // ops-access resolve errors never carry credential paths (registry
    // discipline) — the reason passes through verbatim.
    const { tool, refreshTargets } = setup({ resolveError: 'entry fails schema validation: kubeconfigPath is required' })
    const value = await tool.execute({ action: 'refresh' }, exec())
    expect(refreshTargets).toEqual([])
    expect(value.results[0].status).toBe('skipped')
    expect(value.results[0].error).toContain('schema validation')
  })

  it('without opsAccess refresh is a clean error', async () => {
    const { tool } = setup({ withOpsAccess: false })
    const value = await tool.execute({ action: 'refresh' }, exec())
    expect(value.error).toContain('ops-access service unavailable')
  })

  it('no kubeconfig path appears anywhere in tool output', async () => {
    const { tool } = setup({ k8sEntries: [{ name: 'test' }, { name: 'broken' }] })
    for (const args of [{ action: 'refresh' }, { action: 'overview' }, { action: 'show', cluster: 'test' }]) {
      const value = await tool.execute(args, exec())
      expect(JSON.stringify(value)).not.toContain(KUBECONFIG)
      expect(JSON.stringify(value)).not.toContain('/x/broken/kubeconfig')
      const text = tool.output.render(args, value).map((b: any) => b.text).join('\n')
      expect(text).not.toContain(KUBECONFIG)
    }
  })
})

describe('render', () => {
  it('renders overview compactly with stale markers', async () => {
    const { tool } = setup({
      inventory: inventory({
        'test': section(),
        'down': section({ middleware: [], workloads: [], stale: true, lastError: 'connection refused' }),
      }),
    })
    const value = await tool.execute({ action: 'overview' }, exec())
    const text = tool.output.render({ action: 'overview' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('2 cluster(s)')
    expect(text).toContain('test: 1 middleware (postgres×1), 1 unknown')
    expect(text).toContain('down: 0 middleware (none), 0 unknown')
    expect(text).toContain('[STALE]')
    expect(text).toContain('connection refused')
  })

  it('renders refresh results with per-cluster status', async () => {
    const { tool } = setup({ k8sEntries: [{ name: 'test' }, { name: 'broken' }] })
    const value = await tool.execute({ action: 'refresh' }, exec())
    const text = tool.output.render({ action: 'refresh' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('test: ok (1 middleware, 1 unknown)')
    expect(text).toContain('broken: FAILED — kept previous data (stale)')
  })

  it('makes prometheus-down instances visible in overview and show', async () => {
    const monitored = section({
      prometheusService: 'monitoring/prometheus',
      middleware: [{
        type: 'redis', namespace: 'acme', workload: 'redis', workloadKind: 'StatefulSet',
        images: ['registry.example.com/middleware/redis:7.2'], serviceEntries: ['redis'],
        monitoring: { up: 1, down: 1 },
      }],
      workloads: [
        {
          kind: 'StatefulSet', namespace: 'acme', name: 'redis',
          images: ['registry.example.com/middleware/redis:7.2'],
          labels: {}, podLabels: { app: 'redis' }, env: {},
          configMapRefs: [], secretRefs: [], type: 'redis',
          monitoring: { up: 1, down: 1 },
        },
        {
          kind: 'Deployment', namespace: 'acme', name: 'user-service',
          images: ['registry.example.com/acme/user-service:1.4.2'],
          labels: {}, podLabels: { app: 'user-service' }, env: {},
          configMapRefs: [], secretRefs: [], type: 'unknown',
          monitoring: { up: 1, down: 0 },
        },
      ],
    })
    const { tool } = setup({ inventory: inventory({ 'test': monitored }) })

    const overview = await tool.execute({ action: 'overview' }, exec())
    expect(overview.clusters[0].down).toBe(1)
    const overviewText = tool.output.render({ action: 'overview' }, overview).map((b: any) => b.text).join('\n')
    expect(overviewText).toContain('PROMETHEUS DOWN: 1')

    const show = await tool.execute({ action: 'show', cluster: 'test' }, exec())
    expect(show.cluster.prometheusService).toBe('monitoring/prometheus')
    const showText = tool.output.render({ action: 'show', cluster: 'test' }, show).map((b: any) => b.text).join('\n')
    expect(showText).toContain('prometheus: monitoring/prometheus')
    expect(showText).toContain('prometheus: up 1 [DOWN 1]')
    expect(showText).toContain('prometheus: up 1')
  })
})

// ── show filters ─────────────────────────────────────────────────────────────

/** A two-namespace detail used by the filter tests. */
function richDetail(): ClusterDetail {
  return {
    name: 'test',
    scannedAt: '2026-08-27T11:30:00.000Z',
    stale: false,
    middleware: [
      { type: 'postgres', namespace: 'acme', workload: 'postgres', workloadKind: 'StatefulSet', images: ['postgres:16'], serviceEntries: ['postgres'] },
      { type: 'prometheus', namespace: 'monitoring', workload: 'prometheus', workloadKind: 'StatefulSet', images: ['prom:v2'], serviceEntries: ['prometheus'] },
    ],
    unknown: [
      { name: 'user-service', namespace: 'acme', kind: 'Deployment', images: ['registry.example.com/acme/user-service:1.4.2'] },
      { name: 'mystery', namespace: 'monitoring', kind: 'Deployment', images: ['registry.example.com/acme/mystery:0.1'] },
    ],
    edges: [
      // app in acme uses postgres — survives a acme filter
      { kind: 'uses-middleware', from: { kind: 'Deployment', namespace: 'acme', name: 'user-service' }, to: { kind: 'StatefulSet', namespace: 'acme', name: 'postgres' }, via: 'env:PG_HOST', targetType: 'postgres' },
      // fronts: from is the Service, the workload endpoint is `to`
      { kind: 'fronts', from: { kind: 'Service', namespace: 'acme', name: 'postgres' }, to: { kind: 'StatefulSet', namespace: 'acme', name: 'postgres' }, via: 'selector' },
      { kind: 'fronts', from: { kind: 'Service', namespace: 'monitoring', name: 'prometheus' }, to: { kind: 'StatefulSet', namespace: 'monitoring', name: 'prometheus' }, via: 'selector' },
      // cross-namespace edge whose workload end is filtered out by ns=acme
      { kind: 'uses-middleware', from: { kind: 'Deployment', namespace: 'monitoring', name: 'mystery' }, to: { kind: 'StatefulSet', namespace: 'acme', name: 'postgres' }, via: 'env:X', targetType: 'postgres' },
    ],
    anomalies: [],
    counts: { services: 4, ingresses: 1, workloads: 6 },
  }
}

describe('show filters', () => {
  it('no filters: detail passes through unchanged (same reference)', () => {
    const detail = richDetail()
    expect(filterDetail(detail, {})).toBe(detail)
  })

  it('namespace filter narrows middleware, unknown bucket, and edges', () => {
    const filtered = filterDetail(richDetail(), { namespace: 'acme' })
    expect(filtered.middleware.map(m => m.workload)).toEqual(['postgres'])
    expect(filtered.unknown.map(u => u.name)).toEqual(['user-service'])
    const edgeIds = filtered.edges.map(e => `${e.kind}:${e.from.namespace}/${e.from.name}→${e.to.namespace}/${e.to.name}`)
    // user-service → postgres kept (from in set); postgres fronts kept (to in set);
    // prometheus fronts and the monitoring-originated edge dropped.
    expect(edgeIds).toEqual([
      'uses-middleware:acme/user-service→acme/postgres',
      'fronts:acme/postgres→acme/postgres',
    ])
  })

  it('name filter is a case-insensitive substring match', () => {
    const filtered = filterDetail(richDetail(), { name: 'POST' })
    expect(filtered.middleware.map(m => m.workload)).toEqual(['postgres'])
    expect(filtered.unknown).toEqual([])
    // Only postgres survives; the uses-middleware edge's from (user-service)
    // fell out of the set, the postgres fronts edge's `to` stayed in.
    expect(filtered.edges.map(e => e.kind)).toEqual(['fronts'])
  })

  it('namespace and name combine as AND', () => {
    const filtered = filterDetail(richDetail(), { namespace: 'monitoring', name: 'prom' })
    expect(filtered.middleware.map(m => m.workload)).toEqual(['prometheus'])
    expect(filtered.unknown).toEqual([])
    expect(filtered.edges.map(e => e.kind)).toEqual(['fronts'])
  })

  it('a filter matching nothing yields empty lists, not an error', () => {
    const filtered = filterDetail(richDetail(), { name: 'no-such-thing' })
    expect(filtered.middleware).toEqual([])
    expect(filtered.unknown).toEqual([])
    expect(filtered.edges).toEqual([])
  })

  it('the tool applies filters end-to-end and render echoes them', async () => {
    const { tool } = setup({
      inventory: inventory({
        'test': section({
          middleware: richDetail().middleware,
          edges: richDetail().edges as any,
          workloads: [
            {
              kind: 'Deployment', namespace: 'acme', name: 'user-service',
              images: ['registry.example.com/acme/user-service:1.4.2'],
              labels: {}, podLabels: {}, env: {}, configMapRefs: [], secretRefs: [], type: 'unknown',
            },
            {
              kind: 'Deployment', namespace: 'monitoring', name: 'mystery',
              images: ['registry.example.com/acme/mystery:0.1'],
              labels: {}, podLabels: {}, env: {}, configMapRefs: [], secretRefs: [], type: 'unknown',
            },
          ],
        }),
      }),
    })
    const value = await tool.execute({ action: 'show', cluster: 'test', namespace: 'acme' }, exec())
    expect(value.cluster.middleware.map((m: any) => m.workload)).toEqual(['postgres'])
    expect(value.cluster.unknown.map((u: any) => u.name)).toEqual(['user-service'])
    expect(value.cluster.edges).toHaveLength(2)
    const text = tool.output.render({ action: 'show', cluster: 'test', namespace: 'acme' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('filtered by namespace=acme')
  })

  it('unfiltered show output is byte-identical to before (render carries no filter line)', async () => {
    const { tool } = setup()
    const value = await tool.execute({ action: 'show', cluster: 'test' }, exec())
    const text = tool.output.render({ action: 'show', cluster: 'test' }, value).map((b: any) => b.text).join('\n')
    expect(text).not.toContain('filtered by')
    expect(value.cluster.middleware).toHaveLength(1)
    expect(value.cluster.edges).toHaveLength(1)
  })
})

describe('anomalies surfacing', () => {
  const anomalySection = () => section({
    anomalies: [{
      kind: 'cross-namespace-ref',
      severity: 'info',
      ref: { kind: 'Deployment', namespace: 'acme', name: 'user-service' },
      related: { kind: 'Service', namespace: 'data', name: 'postgresql' },
      message: 'acme/user-service references Service data/postgresql across namespaces',
    }],
  })

  it('overview lists anomalies in their own section, only when present', async () => {
    const withAnomaly = setup({ inventory: inventory({ 'test': anomalySection() }) })
    const value = await withAnomaly.tool.execute({ action: 'overview' }, exec())
    expect(value.clusters[0].anomalies).toBe(1)
    const text = withAnomaly.tool.output.render({ action: 'overview' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('Anomalies:')
    expect(text).toContain('[info] test: acme/user-service references Service data/postgresql across namespaces')
    expect(text).toContain('1 anomalies')

    const clean = setup()
    const cleanValue = await clean.tool.execute({ action: 'overview' }, exec())
    const cleanText = clean.tool.output.render({ action: 'overview' }, cleanValue).map((b: any) => b.text).join('\n')
    expect(cleanText).not.toContain('Anomalies:')
    expect(cleanValue.anomalies).toBeUndefined()
  })

  it('show annotates the involved workload in place', async () => {
    const { tool } = setup({ inventory: inventory({ 'test': anomalySection() }) })
    const value = await tool.execute({ action: 'show', cluster: 'test' }, exec())
    expect(value.cluster.anomalies).toHaveLength(1)
    const text = tool.output.render({ action: 'show', cluster: 'test' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('[!] acme/user-service references Service data/postgresql across namespaces')
  })

  it('service-no-backend anomalies annotate the middleware they front', async () => {
    const svcAnomaly = section({
      anomalies: [{
        kind: 'service-no-backend',
        severity: 'warning',
        ref: { kind: 'Service', namespace: 'acme', name: 'postgres' },
        message: 'Service acme/postgres has a selector but no ready endpoints (no backend pods)',
      }],
    })
    const { tool } = setup({ inventory: inventory({ 'test': svcAnomaly }) })
    const value = await tool.execute({ action: 'show', cluster: 'test' }, exec())
    const text = tool.output.render({ action: 'show', cluster: 'test' }, value).map((b: any) => b.text).join('\n')
    // postgres middleware has serviceEntries ['postgres'] — the warning lands on its line.
    const pgLine = text.split('\n').find(l => l.includes('postgres · acme/postgres'))!
    expect(pgLine).toContain('[!]')
    expect(pgLine).toContain('no ready endpoints')
  })

  it('renders ceph hints in overview and show (ticket 15)', async () => {
    const { tool } = setup({
      inventory: inventory({
        test: section({
          ceph: {
            pools: [{ namespace: 'rook-ceph', name: 'rbd-pool' }, { namespace: 'rook-ceph', name: 'cephfs-data-ec01' }],
            clusters: [{ namespace: 'rook-ceph', name: 'rook-ceph' }],
            toolsPod: { namespace: 'rook-ceph', name: 'rook-ceph-tools-67f5f5587c-kwgnx' },
          },
        }),
      }),
    })
    const overview = await tool.execute({ action: 'overview' }, exec())
    const ovText = tool.output.render({ action: 'overview' }, overview).map((b: any) => b.text).join('\n')
    expect(ovText).toContain('ceph pools: 2')
    const value = await tool.execute({ action: 'show', cluster: 'test' }, exec())
    const text = tool.output.render({ action: 'show', cluster: 'test' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('ceph: pools rbd-pool, cephfs-data-ec01 · cluster rook-ceph/rook-ceph · tools pod rook-ceph/rook-ceph-tools-67f5f5587c-kwgnx')
  })

  it('marks the absent tools pod explicitly (its absence is information)', async () => {
    const { tool } = setup({ inventory: inventory({ test: section({ ceph: { pools: [{ namespace: 'rook-ceph', name: 'rbd-pool' }], clusters: [] } }) }) })
    const value = await tool.execute({ action: 'show', cluster: 'test' }, exec())
    const text = tool.output.render({ action: 'show', cluster: 'test' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('no rook-ceph-tools pod deployed')
  })
})
