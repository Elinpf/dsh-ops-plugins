/**
 * environment tool spec: drives createEnvironmentTool through a mock ctx,
 * covering the four actions, the TTL gate, the ro-only resolve discipline,
 * and the guarantee that no kubeconfig path reaches tool output.
 */

import { describe, expect, it } from 'vitest'
import { createEnvironmentTool } from '../src/tool.js'
import type { EnvironmentToolDeps } from '../src/tool.js'
import type { EnvironmentInventory, InventorySection } from '../src/inventory.js'
import { HELP_TEXT } from '../src/doctrine.js'

const NOW = Date.parse('2026-08-27T12:00:00Z')
const KUBECONFIG = '/home/tester/.dsh-ops/credentials/k8s/pf-test/ro/kubeconfig'

function section(overrides: Partial<InventorySection> = {}): InventorySection {
  return {
    scannedAt: '2026-08-27T11:30:00.000Z', // 30m old — fresh under the 60m TTL
    middleware: [
      {
        type: 'postgres', namespace: 'baizeops', workload: 'postgres',
        workloadKind: 'StatefulSet', images: ['harbor.cnzbai.com/middleware/postgres:16.2'],
        serviceEntries: ['postgres'],
      },
    ],
    workloads: [
      {
        kind: 'Deployment', namespace: 'baizeops', name: 'user-service',
        images: ['harbor.cnzbai.com/baizeops/user-service:1.4.2'],
        labels: {}, podLabels: { app: 'user-service' }, env: {},
        configMapRefs: ['baizeops-config'], secretRefs: ['baizeops-secret'], type: 'unknown',
      },
    ],
    services: [],
    ingresses: [],
    edges: [
      {
        kind: 'uses-middleware',
        from: { kind: 'Deployment', namespace: 'baizeops', name: 'user-service' },
        to: { kind: 'StatefulSet', namespace: 'baizeops', name: 'postgres' },
        via: 'configmap:baizeops-config:PG_HOST',
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
  let stored = opts.inventory === undefined ? inventory({ 'pf-test': section() }) : opts.inventory
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
    listAll: async () => (opts.k8sEntries ?? [{ name: 'pf-test' }]).map(e => ({
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
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['action', 'cluster'])
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
      name: 'pf-test', stale: false, middleware: 1, unknown: 1,
      byType: [{ type: 'postgres', count: 1 }],
    })
  })

  it('show returns middleware, unknown bucket, and edges for a known cluster', async () => {
    const { tool } = setup()
    const value = await tool.execute({ action: 'show', cluster: 'pf-test' }, exec())
    expect(value.cluster.name).toBe('pf-test')
    expect(value.cluster.middleware[0]).toMatchObject({ type: 'postgres', serviceEntries: ['postgres'] })
    expect(value.cluster.unknown[0]).toMatchObject({ name: 'user-service', namespace: 'baizeops' })
    expect(value.cluster.edges[0]).toMatchObject({ kind: 'uses-middleware', targetType: 'postgres' })
  })

  it('show without cluster is an error; unknown cluster lists what is known', async () => {
    const { tool } = setup()
    const missing = await tool.execute({ action: 'show' }, exec())
    expect(missing.error).toContain('requires the cluster parameter')
    const unknown = await tool.execute({ action: 'show', cluster: 'nope' }, exec())
    expect(unknown.error).toContain('unknown cluster "nope"')
    expect(unknown.error).toContain('pf-test')
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
      inventory: inventory({ 'pf-test': section({ scannedAt: '2026-08-27T10:00:00.000Z' }) }), // 2h old
    })
    await tool.execute({ action: 'overview' }, exec())
    expect(calls.refresh).toBe(1)
  })

  it('a stale-marked but young section does NOT trigger a refresh', async () => {
    const { tool, calls } = setup({
      inventory: inventory({ 'pf-test': section({ stale: true, lastError: 'boom' }) }),
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
      k8sEntries: [{ name: 'pf-test' }, { name: 'broken' }],
    })
    const value = await tool.execute({ action: 'refresh' }, exec())
    expect(calls.resolve).toBe(2)
    expect(refreshTargets).toEqual([
      { cluster: 'pf-test', kubeconfigPath: KUBECONFIG },
      { cluster: 'broken', kubeconfigPath: '/x/broken/kubeconfig' },
    ])
    const byCluster = Object.fromEntries(value.results.map((r: any) => [r.cluster, r]))
    expect(byCluster['pf-test']).toMatchObject({ status: 'ok', middleware: 1, unknown: 1 })
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
    const { tool } = setup({ k8sEntries: [{ name: 'pf-test' }, { name: 'broken' }] })
    for (const args of [{ action: 'refresh' }, { action: 'overview' }, { action: 'show', cluster: 'pf-test' }]) {
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
        'pf-test': section(),
        'down': section({ middleware: [], workloads: [], stale: true, lastError: 'connection refused' }),
      }),
    })
    const value = await tool.execute({ action: 'overview' }, exec())
    const text = tool.output.render({ action: 'overview' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('2 cluster(s)')
    expect(text).toContain('pf-test: 1 middleware (postgres×1), 1 unknown')
    expect(text).toContain('down: 0 middleware (none), 0 unknown')
    expect(text).toContain('[STALE]')
    expect(text).toContain('connection refused')
  })

  it('renders refresh results with per-cluster status', async () => {
    const { tool } = setup({ k8sEntries: [{ name: 'pf-test' }, { name: 'broken' }] })
    const value = await tool.execute({ action: 'refresh' }, exec())
    const text = tool.output.render({ action: 'refresh' }, value).map((b: any) => b.text).join('\n')
    expect(text).toContain('pf-test: ok (1 middleware, 1 unknown)')
    expect(text).toContain('broken: FAILED — kept previous data (stale)')
  })

  it('makes prometheus-down instances visible in overview and show', async () => {
    const monitored = section({
      prometheusService: 'monitoring/prometheus',
      middleware: [{
        type: 'redis', namespace: 'baizeops', workload: 'redis', workloadKind: 'StatefulSet',
        images: ['harbor.cnzbai.com/middleware/redis:7.2'], serviceEntries: ['redis'],
        monitoring: { up: 1, down: 1 },
      }],
      workloads: [
        {
          kind: 'StatefulSet', namespace: 'baizeops', name: 'redis',
          images: ['harbor.cnzbai.com/middleware/redis:7.2'],
          labels: {}, podLabels: { app: 'redis' }, env: {},
          configMapRefs: [], secretRefs: [], type: 'redis',
          monitoring: { up: 1, down: 1 },
        },
        {
          kind: 'Deployment', namespace: 'baizeops', name: 'user-service',
          images: ['harbor.cnzbai.com/baizeops/user-service:1.4.2'],
          labels: {}, podLabels: { app: 'user-service' }, env: {},
          configMapRefs: [], secretRefs: [], type: 'unknown',
          monitoring: { up: 1, down: 0 },
        },
      ],
    })
    const { tool } = setup({ inventory: inventory({ 'pf-test': monitored }) })

    const overview = await tool.execute({ action: 'overview' }, exec())
    expect(overview.clusters[0].down).toBe(1)
    const overviewText = tool.output.render({ action: 'overview' }, overview).map((b: any) => b.text).join('\n')
    expect(overviewText).toContain('PROMETHEUS DOWN: 1')

    const show = await tool.execute({ action: 'show', cluster: 'pf-test' }, exec())
    expect(show.cluster.prometheusService).toBe('monitoring/prometheus')
    const showText = tool.output.render({ action: 'show', cluster: 'pf-test' }, show).map((b: any) => b.text).join('\n')
    expect(showText).toContain('prometheus: monitoring/prometheus')
    expect(showText).toContain('prometheus: up 1 [DOWN 1]')
    expect(showText).toContain('prometheus: up 1')
  })
})
