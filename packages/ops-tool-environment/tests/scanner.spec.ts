/**
 * scanner spec: scanCluster against the recorded test-cluster fixtures
 * through a fake exec, covering reduction shape, the secrets metadata-only
 * discipline, error scrubbing, and the default spawn-based runner.
 */

import { describe, expect, it } from 'vitest'
import { defaultExec, ScanError, scanCluster, SCAN_TIMEOUT_MS, scrubKubeconfigPath } from '../src/scanner.js'
import { FAKE_KUBECONFIG, fakeExec, fakeFetch, fakeSpawn, failSpawn } from './helper.ts'

describe('scanCluster', () => {
  it('reduces workloads/services/ingresses/configmaps from recorded responses', async () => {
    const { exec, calls } = fakeExec()
    const scan = await scanCluster({
      cluster: 'test',
      kubeconfigPath: FAKE_KUBECONFIG,
      exec,
      spawn: failSpawn,
      now: new Date('2026-08-27T00:00:00Z'),
    })

    expect(scan.cluster).toBe('test')
    expect(scan.scannedAt).toBe('2026-08-27T00:00:00.000Z')
    expect(scan.workloads).toHaveLength(7)
    expect(scan.services).toHaveLength(6)
    expect(scan.ingresses).toHaveLength(1)
    expect(scan.configMaps).toHaveLength(2)
    expect(scan.secrets).toHaveLength(3)

    // Every call carries the kubeconfig flag and a 30s timeout.
    for (const call of calls) {
      expect(call.args[0]).toBe('kubectl')
      expect(call.args[1]).toBe(`--kubeconfig=${FAKE_KUBECONFIG}`)
      expect(call.timeoutMs).toBe(SCAN_TIMEOUT_MS)
    }
  })

  it('captures literal env values and reference names, but never valueFrom values', async () => {
    const { exec } = fakeExec()
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn })

    const userService = scan.workloads.find(w => w.name === 'user-service')!
    expect(userService.env).toEqual({ REDIS_ADDR: 'redis.acme.svc.cluster.local:6379' })
    expect(userService.configMapRefs).toEqual(['acme-config'])
    expect(userService.secretRefs).toEqual(['acme-secret'])
    expect(userService.images).toEqual(['registry.example.com/acme/user-service:1.4.2'])
    expect(userService.podLabels).toEqual({ app: 'user-service' })

    const gateway = scan.workloads.find(w => w.name === 'gateway')!
    expect(gateway.env).toEqual({}) // both envs are valueFrom — no literal values
    expect(gateway.configMapRefs).toEqual(['acme-config'])
    expect(gateway.secretRefs).toEqual(['acme-secret'])
  })

  it('reads Secrets metadata-only via jsonpath — data is never requested', async () => {
    const { exec, calls } = fakeExec()
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn })

    const secretsCall = calls.find(c => c.args.includes('secrets'))!
    const outputArg = secretsCall.args.find(a => a.startsWith('jsonpath=') || a === 'json')
    expect(outputArg).toMatch(/^jsonpath=/)
    expect(outputArg).toContain('metadata.namespace')
    expect(outputArg).toContain('metadata.name')
    // No Secret data field is ever selected ('metadata' contains 'data' as a
    // substring — assert on the actual field paths instead).
    expect(outputArg).not.toContain('{.data')
    expect(outputArg).not.toContain('stringData')

    expect(scan.secrets).toEqual([
      { namespace: 'acme', name: 'acme-secret' },
      { namespace: 'acme', name: 'postgres-auth' },
      { namespace: 'monitoring', name: 'prometheus-token-x1v2c' },
    ])
    // No Secret data shape anywhere in the scan output.
    expect(JSON.stringify(scan)).not.toContain('stringData')
    expect(JSON.stringify(scan)).not.toContain('DB_PASSWORD')
  })

  it('parses ingress hosts and service backends', async () => {
    const { exec } = fakeExec()
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn })
    const ingress = scan.ingresses[0]
    expect(ingress.hosts).toEqual(['ops.example.com'])
    expect(ingress.serviceBackends).toEqual([
      { serviceName: 'gateway', servicePort: 8080 },
      { serviceName: 'user-service', servicePort: 'http' },
    ])
  })

  it('kubectl failure rejects with ScanError — kubeconfig path scrubbed', async () => {
    const { exec } = fakeExec({ failFor: ['services'] })
    await expect(scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn }))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ScanError)
        const message = (err as Error).message
        expect(message).toContain('<kubeconfig>')
        expect(message).not.toContain(FAKE_KUBECONFIG)
        expect((err as ScanError).cluster).toBe('test')
        return true
      })
  })

  it('cluster unreachable (all calls fail) is a single ScanError, path-scrubbed', async () => {
    const { exec } = fakeExec({ failFor: ['*'] })
    await expect(scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn }))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ScanError)
        expect((err as Error).message).not.toContain(FAKE_KUBECONFIG)
        return true
      })
  })

  it('timeout surfaces as a scrubbed ScanError', async () => {
    const exec = async () => {
      throw new Error(`command timed out after 30000ms (kubeconfig ${FAKE_KUBECONFIG})`)
    }
    await expect(scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn }))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ScanError)
        expect((err as Error).message).toContain('timed out')
        expect((err as Error).message).not.toContain(FAKE_KUBECONFIG)
        return true
      })
  })

  it('malformed JSON response is a ScanError', async () => {
    const { exec } = fakeExec()
    const broken = async (args: string[], opts: { timeoutMs: number }) => {
      if (args.includes('services')) return { stdout: '{not json' }
      return exec(args, opts)
    }
    await expect(scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec: broken, spawn: failSpawn }))
      .rejects.toThrow(ScanError)
  })

  it('attaches Prometheus targets when the cluster has a scrapable Prometheus', async () => {
    const { exec } = fakeExec()
    const { spawn } = fakeSpawn({ ready: true })
    const scan = await scanCluster({
      cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn, fetchFn: fakeFetch,
    })
    expect(scan.prometheus?.service).toBe('monitoring/prometheus')
    expect(scan.prometheus?.targets).toHaveLength(9)
  })

  it('Prometheus failure never breaks the main scan', async () => {
    const { exec } = fakeExec()
    const scan = await scanCluster({
      cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec,
      spawn: failSpawn, // port-forward cannot even start
    })
    expect(scan.prometheus).toBeUndefined()
    expect(scan.workloads).toHaveLength(7)
  })

  it('secrets forbidden (strict ro account) degrades to an empty secrets list', async () => {
    // The k8s view ClusterRole does not include secrets — the metadata-only
    // read must not fail the whole cluster.
    const { exec } = fakeExec({ failFor: ['secrets'] })
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn })
    expect(scan.secrets).toEqual([])
    expect(scan.workloads).toHaveLength(7)
  })
})

describe('scrubKubeconfigPath', () => {
  it('replaces every occurrence of the path', () => {
    const text = `stat ${FAKE_KUBECONFIG}: no such file; also --kubeconfig=${FAKE_KUBECONFIG}`
    const scrubbed = scrubKubeconfigPath(text, FAKE_KUBECONFIG)
    expect(scrubbed).toBe('stat <kubeconfig>: no such file; also --kubeconfig=<kubeconfig>')
  })
})

describe('defaultExec (real spawn)', () => {
  it('captures stdout of a successful command', async () => {
    const { stdout } = await defaultExec(['node', '-e', 'process.stdout.write("ok")'], { timeoutMs: 10_000 })
    expect(stdout).toBe('ok')
  })

  it('rejects on non-zero exit with stderr in the message', async () => {
    await expect(defaultExec(['node', '-e', 'process.stderr.write("boom"); process.exit(3)'], { timeoutMs: 10_000 }))
      .rejects.toThrow(/code 3.*boom/)
  })

  it('rejects when the binary does not exist', async () => {
    await expect(defaultExec(['kubectl-definitely-missing-binary', 'version'], { timeoutMs: 10_000 }))
      .rejects.toThrow()
  })
})

describe('rook-ceph hints (ticket 15)', () => {
  it('collects pools, cluster, and tools pod location', async () => {
    const { exec } = fakeExec()
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn })
    expect(scan.ceph?.pools.map(p => p.name)).toEqual(['rbd-pool', 'cephfs-data-ec01'])
    expect(scan.ceph?.clusters).toEqual([{ namespace: 'rook-ceph', name: 'rook-ceph' }])
    expect(scan.ceph?.toolsPod).toEqual({ namespace: 'rook-ceph', name: 'rook-ceph-tools-67f5f5587c-kwgnx' })
  })

  it('ceph CRs forbidden (ro without rook RBAC) still reports the tools pod', async () => {
    const { exec } = fakeExec({ failFor: ['ceph-crs'] })
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn })
    expect(scan.ceph?.pools).toEqual([])
    expect(scan.ceph?.toolsPod?.name).toBe('rook-ceph-tools-67f5f5587c-kwgnx')
  })

  it('tools-pod read failure keeps the CR hints', async () => {
    const { exec } = fakeExec({ failFor: ['pods-ceph-tools'] })
    const scan = await scanCluster({ cluster: 'test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn })
    expect(scan.ceph?.pools).toHaveLength(2)
    expect(scan.ceph?.toolsPod).toBeUndefined()
  })
})
