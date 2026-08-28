/**
 * Shared test helper: a fake kubectl runner replaying the recorded
 * test-cluster fixtures, keyed by the resource argument.
 */

import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { SpawnFn } from '../src/prometheus.js'
import type { ExecFn } from '../src/scanner.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test-cluster')

/** A kubeconfig path that looks real — tests assert it never leaks. */
export const FAKE_KUBECONFIG = '/home/tester/.dsh-ops/credentials/k8s/test/ro/kubeconfig'

export function fixtureText(name: string, fixtureDir: string = FIXTURE_DIR): string {
  return readFileSync(join(fixtureDir, name), 'utf8')
}

export function fixtureDirFor(cluster: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fixtures', cluster)
}

export interface FakeExecCall {
  args: string[]
  timeoutMs: number
}

/** Build an exec that serves fixtures. `failFor` resources reject instead. */
export function fakeExec(opts: { failFor?: string[], fixtureDir?: string } = {}): { exec: ExecFn, calls: FakeExecCall[] } {
  const dir = opts.fixtureDir ?? FIXTURE_DIR
  const calls: FakeExecCall[] = []
  const exec: ExecFn = async (args, { timeoutMs }) => {
    calls.push({ args, timeoutMs })
    let resource = args[args.indexOf('get') + 1]
    // Normalized keys for the ticket-15 rook-ceph reads.
    if (resource === 'cephclusters.ceph.rook.io,cephblockpools.ceph.rook.io') resource = 'ceph-crs'
    else if (resource === 'pods') resource = 'pods-ceph-tools'
    if (opts.failFor?.includes(resource) || opts.failFor?.includes('*')) {
      // kubectl echoes the kubeconfig path in its errors — as the real CLI does.
      throw new Error(`kubectl exited with code 1: error loading config file "${FAKE_KUBECONFIG}": connection refused`)
    }
    if (resource === 'deployments,statefulsets,daemonsets') return { stdout: fixtureText('workloads.json', dir) }
    if (resource === 'services') return { stdout: fixtureText('services.json', dir) }
    if (resource === 'ingresses') return { stdout: fixtureText('ingresses.json', dir) }
    if (resource === 'configmaps') return { stdout: fixtureText('configmaps.json', dir) }
    if (resource === 'endpoints') return { stdout: fixtureText('endpoints.json', dir) }
    if (resource === 'secrets') return { stdout: fixtureText('secrets.jsonpath', dir) }
    if (resource === 'ceph-crs') return { stdout: fixtureText('ceph-crs.json', dir) }
    if (resource === 'pods-ceph-tools') return { stdout: fixtureText('pods-ceph-tools.jsonpath', dir) }
    throw new Error(`unexpected resource: ${resource}`)
  }
  return { exec, calls }
}

// ── Port-forward fakes (Prometheus scrape) ───────────────────────────────────

/** Spawn that always throws — tests that must not touch Prometheus use this. */
export const failSpawn: SpawnFn = () => {
  throw new Error('spawn disabled in this test')
}

export interface FakeChild {
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  /** Signals received, in order — tests assert the child was reaped. */
  kills: Array<NodeJS.Signals | undefined>
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null) => void): unknown
}

/**
 * A fake port-forward child. `ready` children announce "Forwarding from ..."
 * on stdout shortly after spawn; non-ready ones stay silent (timeout path).
 * kill() records the signal and emits exit, like a real process would.
 */
export function fakeSpawn(opts: { ready?: boolean, exitEarly?: boolean } = {}): { spawn: SpawnFn, children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawn: SpawnFn = (args) => {
    const emitter = new EventEmitter()
    const child: FakeChild = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kills: [],
      kill(signal) {
        child.kills.push(signal)
        setTimeout(() => {
          child.exitCode = 0
          emitter.emit('exit', 0)
        }, 1)
        return true
      },
      once: (event, listener) => emitter.once(event, listener),
    }
    const localPort = Number(args[args.length - 1].split(':')[0])
    children.push(child)
    if (opts.exitEarly) {
      // kubectl failing immediately (e.g. unreachable cluster).
      setTimeout(() => {
        child.exitCode = 1
        emitter.emit('exit', 1)
      }, 5)
    } else if (opts.ready) {
      setTimeout(() => {
        child.stdout.write(`Forwarding from 127.0.0.1:${localPort} -> 9090\n`)
      }, 5)
    }
    return child
  }
  return { spawn, children }
}

/** fetch that serves the recorded targets fixture. */
export const fakeFetch: typeof fetch = (async () => new Response(fixtureText('prometheus-targets.json'), { status: 200 })) as any

/** fetch that always fails. */
export const failingFetch: typeof fetch = (async () => { throw new Error('connect ECONNREFUSED') }) as any
