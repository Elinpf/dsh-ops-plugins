/**
 * prometheus spec: discovery heuristic, targets parsing, workload matching,
 * and the port-forward lifecycle (readiness, cleanup on every path, timeouts).
 */

import { describe, expect, it } from 'vitest'
import {
  findPrometheusService,
  matchTargetsToWorkloads,
  parseActiveTargets,
  scrapePrometheusTargets,
} from '../src/prometheus.js'
import type { ScannedService } from '../src/types.js'
import { FAKE_KUBECONFIG, fakeFetch, fakeSpawn, failSpawn, failingFetch, fixtureText } from './helper.ts'

function svc(name: string, namespace: string, ports: number[] = [9090]): ScannedService {
  return {
    namespace, name, type: 'ClusterIP', selector: null, labels: {},
    ports: ports.map(port => ({ port })),
  }
}

const FIXTURE_SERVICES: ScannedService[] = JSON.parse(fixtureText('services.json')).items.map((item: any) => ({
  namespace: item.metadata.namespace,
  name: item.metadata.name,
  type: item.spec.type,
  ports: (item.spec.ports ?? []).map((p: any) => ({ port: p.port, targetPort: p.targetPort })),
  selector: item.spec.selector ?? null,
  labels: item.metadata.labels ?? {},
}))

describe('findPrometheusService', () => {
  it('finds the monitoring-namespace prometheus service in the recorded cluster', () => {
    const found = findPrometheusService(FIXTURE_SERVICES)
    expect(found?.namespace).toBe('monitoring')
    expect(found?.name).toBe('prometheus')
  })

  it('prefers the monitoring namespace over other candidates', () => {
    const services = [
      svc('team-prometheus', 'team-a'),
      svc('kube-prometheus-stack-prometheus', 'monitoring'),
    ]
    expect(findPrometheusService(services)?.name).toBe('kube-prometheus-stack-prometheus')
  })

  it('falls back to a prometheus service outside monitoring', () => {
    expect(findPrometheusService([svc('team-prometheus', 'team-a')])?.name).toBe('team-prometheus')
  })

  it('ignores prometheus-named services without port 9090, and absent candidates', () => {
    expect(findPrometheusService([svc('prometheus-operated', 'monitoring', [8080])])).toBeUndefined()
    expect(findPrometheusService(FIXTURE_SERVICES.filter(s => s.name !== 'prometheus'))).toBeUndefined()
  })
})

describe('parseActiveTargets', () => {
  it('reduces the recorded response to ns/pod/service/job/health', () => {
    const targets = parseActiveTargets(JSON.parse(fixtureText('prometheus-targets.json')))
    expect(targets).toHaveLength(9)
    expect(targets[0]).toEqual({
      namespace: 'acme', pod: 'postgres-0', service: 'postgres',
      job: 'postgres-exporter', health: 'up',
    })
    expect(targets.find(t => t.pod === 'redis-1')?.health).toBe('down')
    // The blackbox target has no pod/namespace — labels are simply absent.
    const blackbox = targets.find(t => t.job === 'external-blackbox')!
    expect(blackbox.pod).toBeUndefined()
    expect(blackbox.namespace).toBeUndefined()
  })

  it('malformed responses yield [], never throw', () => {
    expect(parseActiveTargets(null)).toEqual([])
    expect(parseActiveTargets({})).toEqual([])
    expect(parseActiveTargets({ data: { activeTargets: 'nope' } })).toEqual([])
    expect(parseActiveTargets({ data: { activeTargets: [{ labels: {} }] } })).toEqual([])
  })
})

describe('matchTargetsToWorkloads', () => {
  const workloads = [
    { namespace: 'acme', name: 'postgres' },
    { namespace: 'acme', name: 'redis' },
    { namespace: 'acme', name: 'user-service' },
    { namespace: 'acme', name: 'user' }, // prefix-collision bait
    { namespace: 'monitoring', name: 'prometheus' },
  ]
  const targets = parseActiveTargets(JSON.parse(fixtureText('prometheus-targets.json')))

  it('matches pods to workloads by namespace + name prefix', () => {
    const statuses = matchTargetsToWorkloads(workloads, targets)
    expect(statuses.get('acme/postgres')).toEqual({ up: 1, down: 0 })
    expect(statuses.get('acme/redis')).toEqual({ up: 1, down: 1 })
    expect(statuses.get('monitoring/prometheus')).toEqual({ up: 1, down: 0 })
  })

  it('the longest name wins prefix collisions; unmatched and pod-less targets drop', () => {
    const statuses = matchTargetsToWorkloads(workloads, targets)
    // user-service-7d9f4c6b5-x1a2b matches BOTH `user-service-` and `user-` prefixes.
    expect(statuses.get('acme/user-service')).toEqual({ up: 1, down: 0 })
    expect(statuses.get('acme/user')).toBeUndefined()
    // ghost-0 matches no workload; the blackbox target has no pod label.
    expect(statuses.get('acme/ghost')).toBeUndefined()
    expect([...statuses.keys()]).toHaveLength(4)
  })
})

describe('scrapePrometheusTargets lifecycle', () => {
  it('happy path: port-forward, fetch targets, reap the child', async () => {
    const { spawn, children } = fakeSpawn({ ready: true })
    const result = await scrapePrometheusTargets({
      kubeconfigPath: FAKE_KUBECONFIG,
      services: FIXTURE_SERVICES,
      spawn,
      fetchFn: fakeFetch,
    })
    expect(result?.service).toBe('monitoring/prometheus')
    expect(result?.targets).toHaveLength(9)

    // The child was reaped: SIGTERM first, SIGKILL tolerated after.
    expect(children).toHaveLength(1)
    expect(children[0].kills.length).toBeGreaterThan(0)
    expect(children[0].kills[0]).toBe('SIGTERM')
  })

  it('port-forward argv targets the discovered service with a local port', async () => {
    const seen: string[][] = []
    const base = fakeSpawn({ ready: true })
    const spawn = (args: string[]) => {
      seen.push(args)
      return base.spawn(args)
    }
    await scrapePrometheusTargets({
      kubeconfigPath: FAKE_KUBECONFIG, services: FIXTURE_SERVICES, spawn, fetchFn: fakeFetch,
    })
    const args = seen[0]
    expect(args[0]).toBe('kubectl')
    expect(args).toContain(`--kubeconfig=${FAKE_KUBECONFIG}`)
    expect(args).toContain('port-forward')
    expect(args).toContain('svc/prometheus')
    expect(args).toContain('monitoring')
    expect(args[args.length - 1]).toMatch(/^\d+:9090$/)
  })

  it('no Prometheus service: returns undefined without spawning', async () => {
    const { spawn, children } = fakeSpawn({ ready: true })
    const result = await scrapePrometheusTargets({
      kubeconfigPath: FAKE_KUBECONFIG,
      services: FIXTURE_SERVICES.filter(s => s.name !== 'prometheus'),
      spawn,
      fetchFn: fakeFetch,
    })
    expect(result).toBeUndefined()
    expect(children).toHaveLength(0)
  })

  it('readiness timeout: returns undefined and the child is killed', async () => {
    const { spawn, children } = fakeSpawn({ ready: false }) // never announces forwarding
    const result = await scrapePrometheusTargets({
      kubeconfigPath: FAKE_KUBECONFIG,
      services: FIXTURE_SERVICES,
      spawn,
      fetchFn: fakeFetch,
      timeoutMs: 100,
    })
    expect(result).toBeUndefined()
    expect(children).toHaveLength(1)
    expect(children[0].kills).toContain('SIGTERM')
    expect(children[0].kills).toContain('SIGKILL')
    expect(children[0].exitCode).not.toBeNull()
  })

  it('kubectl exits before ready (unreachable cluster): undefined, child reaped', async () => {
    const { spawn, children } = fakeSpawn({ exitEarly: true })
    const result = await scrapePrometheusTargets({
      kubeconfigPath: FAKE_KUBECONFIG,
      services: FIXTURE_SERVICES,
      spawn,
      fetchFn: fakeFetch,
      timeoutMs: 5_000,
    })
    expect(result).toBeUndefined()
    expect(children).toHaveLength(1)
  })

  it('fetch failure after a ready tunnel: undefined, child still reaped', async () => {
    const { spawn, children } = fakeSpawn({ ready: true })
    const result = await scrapePrometheusTargets({
      kubeconfigPath: FAKE_KUBECONFIG,
      services: FIXTURE_SERVICES,
      spawn,
      fetchFn: failingFetch,
    })
    expect(result).toBeUndefined()
    expect(children[0].kills.length).toBeGreaterThan(0)
  })

  it('spawn throwing: undefined, nothing to reap', async () => {
    const result = await scrapePrometheusTargets({
      kubeconfigPath: FAKE_KUBECONFIG,
      services: FIXTURE_SERVICES,
      spawn: failSpawn,
      fetchFn: fakeFetch,
    })
    expect(result).toBeUndefined()
  })
})
