/**
 * anomalies spec: both detectors' positive/negative cases, the endpoints
 * unavailability guard, and an end-to-end run over the synthetic
 * "someone else's cluster" fixture (shop-cluster: bitnami helm shapes,
 * release-name prefixes, standard helm labels — nothing like test).
 */

import { describe, expect, it } from 'vitest'
import { detectAnomalies } from '../src/anomalies.js'
import { scanCluster } from '../src/scanner.js'
import { buildClusterInventory } from '../src/inventory.js'
import type { RelationEdge, ScannedEndpoints, ScannedService } from '../src/types.js'
import { FAKE_KUBECONFIG, fakeExec, failSpawn, fixtureDirFor } from './helper.ts'

const NOW = new Date('2026-08-27T00:00:00Z')
const NO_USER_RULES = '/nonexistent/environment-rules.yaml'

function edge(fromNs: string, fromName: string, toNs: string, toName: string, kind: RelationEdge['kind'] = 'uses-service'): RelationEdge {
  return {
    kind,
    from: { kind: 'Deployment', namespace: fromNs, name: fromName },
    to: { kind: 'Service', namespace: toNs, name: toName },
    via: 'env:X',
  }
}

function svc(name: string, namespace: string, selector: Record<string, string> | null): ScannedService {
  return { namespace, name, type: 'ClusterIP', ports: [{ port: 80 }], selector, labels: {} }
}

function ep(name: string, namespace: string, addresses: number): ScannedEndpoints {
  return { namespace, name, addresses }
}

describe('cross-namespace-ref detector', () => {
  it('flags a uses-service edge whose Service lives in another namespace', () => {
    const anomalies = detectAnomalies({
      edges: [edge('web', 'frontend', 'data', 'postgresql')],
      services: [],
      endpoints: [],
    })
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]).toMatchObject({
      kind: 'cross-namespace-ref',
      severity: 'info',
      ref: { kind: 'Deployment', namespace: 'web', name: 'frontend' },
      related: { kind: 'Service', namespace: 'data', name: 'postgresql' },
    })
    expect(anomalies[0].message).toContain('web/frontend')
    expect(anomalies[0].message).toContain('data/postgresql')
  })

  it('stays silent for same-namespace references and non-service edges', () => {
    const anomalies = detectAnomalies({
      edges: [
        edge('web', 'frontend', 'web', 'backend'),
        edge('web', 'frontend', 'web', 'frontend', 'fronts'),
        { ...edge('web', 'frontend', 'web', 'app-secret'), kind: 'references-secret' },
      ],
      services: [],
      endpoints: [],
    })
    expect(anomalies).toEqual([])
  })

  it('deduplicates repeated references between the same pair', () => {
    const anomalies = detectAnomalies({
      edges: [edge('web', 'frontend', 'data', 'postgresql'), edge('web', 'frontend', 'data', 'postgresql')],
      services: [],
      endpoints: [],
    })
    expect(anomalies).toHaveLength(1)
  })
})

describe('service-no-backend detector', () => {
  const services = [
    svc('postgresql', 'data', { 'app.kubernetes.io/name': 'postgresql' }),
    svc('redis', 'data', { 'app.kubernetes.io/name': 'redis' }),
    svc('ghost', 'data', { 'app.kubernetes.io/name': 'ghost' }),
    svc('external', 'data', null), // selector-less: no backend contract
  ]
  const endpoints = [
    ep('postgresql', 'data', 2),
    ep('redis', 'data', 0),
    // ghost: no Endpoints object at all
    // external: selector-less, must be skipped regardless
  ]

  it('flags selector Services with zero ready addresses or no Endpoints object', () => {
    const anomalies = detectAnomalies({ edges: [], services, endpoints })
    const flagged = anomalies.filter(a => a.kind === 'service-no-backend')
    expect(flagged.map(a => a.ref.name).sort()).toEqual(['ghost', 'redis'])
    expect(flagged.every(a => a.severity === 'warning')).toBe(true)
  })

  it('stays silent for Services with ready backends and for selector-less Services', () => {
    const anomalies = detectAnomalies({ edges: [], services, endpoints })
    expect(anomalies.some(a => a.ref.name === 'postgresql')).toBe(false)
    expect(anomalies.some(a => a.ref.name === 'external')).toBe(false)
  })

  it('skips entirely when the endpoints read failed (undefined) — never guesses', () => {
    const anomalies = detectAnomalies({ edges: [], services, endpoints: undefined })
    expect(anomalies).toEqual([])
  })
})

describe('generality: the synthetic shop-cluster fixture (bitnami helm shapes)', () => {
  async function scanShop() {
    const { exec } = fakeExec({ fixtureDir: fixtureDirFor('shop-cluster') })
    return scanCluster({ cluster: 'shop-prod', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn, now: NOW })
  }

  it('scans and classifies a foreign cluster shape', async () => {
    const scan = await scanShop()
    const inventory = buildClusterInventory(scan, { userRulesFile: NO_USER_RULES })
    // helm labels classify the bitnami postgresql sts; the frontend stays unknown.
    expect(inventory.middleware.map(m => `${m.namespace}/${m.workload}:${m.type}`)).toEqual(['data/shop-postgresql:postgres'])
    expect(inventory.workloads.find(w => w.name === 'shop-frontend')!.type).toBe('unknown')
  })

  it('detects both anomaly kinds on the foreign cluster', async () => {
    const scan = await scanShop()
    const inventory = buildClusterInventory(scan, { userRulesFile: NO_USER_RULES })
    const kinds = inventory.anomalies.map(a => `${a.kind}:${a.ref.namespace}/${a.ref.name}`).sort()
    expect(kinds).toEqual([
      // frontend (shop) talks to postgresql and redis in data
      'cross-namespace-ref:shop/shop-frontend',
      'cross-namespace-ref:shop/shop-frontend',
      // shop-redis has a selector but zero ready endpoints
      'service-no-backend:data/shop-redis',
    ])
    // Negative cases: the same-namespace SELF_CHECK reference and the healthy
    // postgresql/frontend Services produce no anomalies.
    expect(inventory.anomalies.some(a => a.related?.name === 'shop-frontend')).toBe(false)
    expect(inventory.anomalies.some(a => a.ref.name === 'shop-postgresql')).toBe(false)
    expect(inventory.anomalies.some(a => a.ref.name === 'shop-frontend' && a.kind === 'service-no-backend')).toBe(false)
  })
})

describe('test-cluster fixture: no anomalies (regression)', () => {
  it('the recorded healthy cluster stays anomaly-free', async () => {
    const { exec } = fakeExec()
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn, now: NOW })
    expect(scan.endpoints).toBeDefined()
    const inventory = buildClusterInventory(scan, { userRulesFile: NO_USER_RULES })
    expect(inventory.anomalies).toEqual([])
  })

  it('a failed endpoints read leaves the section written but the detector silent', async () => {
    const { exec } = fakeExec({ failFor: ['endpoints'] })
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn, now: NOW })
    expect(scan.endpoints).toBeUndefined()
    expect(scan.workloads).toHaveLength(7) // main scan unaffected
    const inventory = buildClusterInventory(scan, { userRulesFile: NO_USER_RULES })
    expect(inventory.anomalies).toEqual([])
  })
})
