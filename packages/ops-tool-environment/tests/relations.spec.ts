/**
 * relations spec: edges derived from the recorded test-cluster scan —
 * Service fronts, env/ConfigMap svc addresses, composed uses-middleware
 * edges, and reference-only Secret edges. Best-effort: noise yields nothing.
 */

import { describe, expect, it } from 'vitest'
import { scanCluster } from '../src/scanner.js'
import { classifyWorkload } from '../src/classify.js'
import { buildRelations, findServiceAddresses } from '../src/relations.js'
import type { ClassifiedWorkload, RelationEdge } from '../src/types.js'
import { FAKE_KUBECONFIG, fakeExec, failSpawn } from './helper.ts'

async function scanAndClassify() {
  const { exec } = fakeExec()
  const scan = await scanCluster({
    cluster: 'test',
    kubeconfigPath: FAKE_KUBECONFIG,
    exec,
    spawn: failSpawn,
    now: new Date('2026-08-27T00:00:00Z'),
  })
  const classified: ClassifiedWorkload[] = scan.workloads.map(w => ({
    ...w,
    // Point the user-rules lookup at a nonexistent file so the real
    // ~/.dsh-ops/environment-rules.yaml can never influence tests.
    type: classifyWorkload(w, { userRulesFile: '/nonexistent/environment-rules.yaml' }),
  }))
  return { scan, classified }
}

function edgeExists(edges: RelationEdge[], expected: Partial<RelationEdge> & { fromName: string, toName: string }): boolean {
  return edges.some(e =>
    e.kind === expected.kind
    && e.from.name === expected.fromName
    && e.to.name === expected.toName
    && (expected.via === undefined || e.via === expected.via)
    && (expected.targetType === undefined || e.targetType === expected.targetType))
}

describe('findServiceAddresses', () => {
  it('extracts FQDNs from bare hosts, URLs, and JDBC strings', () => {
    expect(findServiceAddresses('postgres.acme.svc.cluster.local')).toEqual([
      { name: 'postgres', namespace: 'acme' },
    ])
    expect(findServiceAddresses('jdbc:postgresql://postgres.acme.svc.cluster.local:5432/report')).toEqual([
      { name: 'postgres', namespace: 'acme' },
    ])
    expect(findServiceAddresses('redis.acme.svc:6379')).toEqual([
      { name: 'redis', namespace: 'acme' },
    ])
  })

  it('ignores non-cluster addresses', () => {
    expect(findServiceAddresses('erp.corp.internal')).toEqual([])
    expect(findServiceAddresses('info')).toEqual([])
    expect(findServiceAddresses('localhost:5432')).toEqual([])
  })
})

describe('buildRelations on the recorded test-cluster scan', () => {
  it('fronts edges come from Service selectors matching pod template labels', async () => {
    const { scan, classified } = await scanAndClassify()
    const edges = buildRelations({ scan, classified })
    expect(edgeExists(edges, { kind: 'fronts', fromName: 'postgres', toName: 'postgres' })).toBe(true)
    expect(edgeExists(edges, { kind: 'fronts', fromName: 'redis', toName: 'redis' })).toBe(true)
    expect(edgeExists(edges, { kind: 'fronts', fromName: 'prometheus', toName: 'prometheus' })).toBe(true)
    expect(edgeExists(edges, { kind: 'fronts', fromName: 'user-service', toName: 'user-service' })).toBe(true)
    // Selector-less ExternalName service fronts nothing.
    expect(edges.some(e => e.kind === 'fronts' && e.from.name === 'legacy-erp')).toBe(false)
  })

  it('uses-service edges come from ConfigMap data and plaintext env values', async () => {
    const { scan, classified } = await scanAndClassify()
    const edges = buildRelations({ scan, classified })
    // user-service consumes acme-config via envFrom -> PG_HOST.
    expect(edgeExists(edges, {
      kind: 'uses-service', fromName: 'user-service', toName: 'postgres',
      via: 'configmap:acme-config:PG_HOST',
    })).toBe(true)
    // ... and points at redis directly via a literal env value.
    expect(edgeExists(edges, {
      kind: 'uses-service', fromName: 'user-service', toName: 'redis',
      via: 'env:REDIS_ADDR',
    })).toBe(true)
    // gateway reads acme-config through a configMapKeyRef -> REPORT_DB JDBC URL.
    expect(edgeExists(edges, {
      kind: 'uses-service', fromName: 'gateway', toName: 'postgres',
      via: 'configmap:acme-config:REPORT_DB',
    })).toBe(true)
  })

  it('composes uses-middleware edges with the classified target type', async () => {
    const { scan, classified } = await scanAndClassify()
    const edges = buildRelations({ scan, classified })
    expect(edgeExists(edges, {
      kind: 'uses-middleware', fromName: 'user-service', toName: 'postgres', targetType: 'postgres',
    })).toBe(true)
    expect(edgeExists(edges, {
      kind: 'uses-middleware', fromName: 'user-service', toName: 'redis', targetType: 'redis',
    })).toBe(true)
    expect(edgeExists(edges, {
      kind: 'uses-middleware', fromName: 'gateway', toName: 'postgres', targetType: 'postgres',
    })).toBe(true)
    // No uses-middleware edge to an unknown workload (user-service fronts itself).
    expect(edges.some(e => e.kind === 'uses-middleware' && e.to.name === 'user-service')).toBe(false)
  })

  it('Secret references are name-only edges — no values anywhere', async () => {
    const { scan, classified } = await scanAndClassify()
    const edges = buildRelations({ scan, classified })
    expect(edgeExists(edges, { kind: 'references-secret', fromName: 'user-service', toName: 'acme-secret' })).toBe(true)
    expect(edgeExists(edges, { kind: 'references-secret', fromName: 'postgres', toName: 'postgres-auth' })).toBe(true)
    const json = JSON.stringify(edges)
    expect(json).not.toContain('DB_PASSWORD')
    expect(json).not.toContain(FAKE_KUBECONFIG)
  })

  it('addresses without a matching scanned Service produce no edge', async () => {
    const { scan, classified } = await scanAndClassify()
    const mutant = classified.map(w => w.name === 'gateway'
      ? { ...w, env: { ELSEWHERE: 'missing.other-ns.svc.cluster.local' } }
      : w)
    const edges = buildRelations({ scan, classified: mutant })
    expect(edges.some(e => e.to.name === 'missing')).toBe(false)
  })

  it('is best-effort: malformed input yields [], never throws', () => {
    expect(buildRelations({ scan: null as any, classified: null as any })).toEqual([])
  })
})
