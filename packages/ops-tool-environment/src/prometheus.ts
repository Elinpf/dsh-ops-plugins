/**
 * Prometheus read-only corroboration (spec 0003, ticket 03).
 *
 * When a cluster has a discoverable Prometheus service, the scanner opens a
 * `kubectl port-forward` to it, reads `/api/v1/targets?state=active`, and
 * matches targets onto workloads by namespace + pod-name prefix. The result
 * is a compact `monitoring: { up, down }` per workload — k8s data and
 * Prometheus state corroborate each other, and a down instance surfaces in
 * the inventory.
 *
 * Everything here is an ENHANCEMENT, never a hard dependency: no Prometheus
 * service, port-forward failure, timeout, or malformed response all degrade
 * to "no monitoring data" — the cluster section is still written and is NOT
 * marked stale (stale is reserved for k8s scan failures).
 *
 * Lifecycle discipline: the port-forward child is always killed (SIGKILL
 * after a SIGTERM grace) and reaped before this module returns, on every
 * path — success, error, or timeout. The kubeconfig path appears only in
 * the child's argv, never in returned data.
 *
 * @module @elinpf/dsh-ops-tool-environment
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { ScannedService } from './types.js'

// ── Types ────────────────────────────────────────────────────────────────────

/** One active Prometheus target, reduced to what matching needs. */
export interface PromTarget {
  namespace?: string
  pod?: string
  service?: string
  job?: string
  /** Prometheus health string: 'up' | 'down' | 'unknown'. */
  health: string
}

/** Compact per-workload monitoring status attached to inventory entries. */
export interface MonitoringStatus {
  up: number
  down: number
}

/** Minimal child-process surface the scraper drives (injectable for tests). */
export interface PortForwardProcess {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  /** Set once the process has exited (node's ChildProcess has this natively). */
  exitCode?: number | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null) => void): unknown
}

export type SpawnFn = (args: string[]) => PortForwardProcess

const defaultSpawn: SpawnFn = (args) => spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Find the cluster's Prometheus service. Heuristic: a Service whose name
 * contains 'prometheus' and which exposes port 9090; the `monitoring`
 * namespace wins ties (kube-prometheus-stack names its service
 * `*-kube-prometheus-stack-prometheus` there). Returns undefined when no
 * candidate exists — the caller then skips the enhancement.
 */
export function findPrometheusService(services: ScannedService[]): ScannedService | undefined {
  const candidates = services.filter(s =>
    s.name.includes('prometheus') && s.ports.some(p => p.port === 9090))
  return candidates.find(s => s.namespace === 'monitoring') ?? candidates[0]
}

// ── Targets parsing ──────────────────────────────────────────────────────────

/** Parse a /api/v1/targets response. Malformed input yields [], never throws. */
export function parseActiveTargets(body: unknown): PromTarget[] {
  try {
    const data = (body as { data?: { activeTargets?: unknown[] } } | null)?.data
    if (!data || !Array.isArray(data.activeTargets)) return []
    const targets: PromTarget[] = []
    for (const entry of data.activeTargets) {
      const labels = (entry as { labels?: Record<string, unknown>, health?: unknown })?.labels ?? {}
      const health = (entry as { health?: unknown })?.health
      if (typeof health !== 'string') continue
      const target: PromTarget = { health }
      for (const key of ['namespace', 'pod', 'service', 'job'] as const) {
        const value = labels[key]
        if (typeof value === 'string' && value !== '') target[key] = value
      }
      targets.push(target)
    }
    return targets
  } catch {
    return []
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface WorkloadIdentity {
  namespace: string
  name: string
}

function workloadKey(w: WorkloadIdentity): string {
  return `${w.namespace}/${w.name}`
}

/**
 * Match targets onto workloads by namespace + pod-name prefix
 * (`<workload>-<suffix>` covers Deployment ReplicaSet hashes, StatefulSet
 * ordinals, and DaemonSet suffixes). A pod matching several names goes to
 * the LONGEST one (`foo-bar-xyz` belongs to `foo-bar`, not `foo`).
 * Targets without a pod label, or matching no workload, are dropped.
 */
export function matchTargetsToWorkloads(
  workloads: WorkloadIdentity[],
  targets: PromTarget[],
): Map<string, MonitoringStatus> {
  const statuses = new Map<string, MonitoringStatus>()
  for (const target of targets) {
    if (!target.namespace || !target.pod) continue
    let best: WorkloadIdentity | undefined
    for (const w of workloads) {
      if (w.namespace !== target.namespace) continue
      if (target.pod !== w.name && !target.pod.startsWith(`${w.name}-`)) continue
      if (!best || w.name.length > best.name.length) best = w
    }
    if (!best) continue
    const key = workloadKey(best)
    const status = statuses.get(key) ?? { up: 0, down: 0 }
    if (target.health === 'up') status.up++
    else if (target.health === 'down') status.down++
    statuses.set(key, status)
  }
  return statuses
}

// ── Port-forward lifecycle ───────────────────────────────────────────────────

export interface ScrapeOptions {
  kubeconfigPath: string
  /** The scanned services of the cluster (discovery source). */
  services: ScannedService[]
  /** Injectable process spawn (tests); defaults to node:child_process. */
  spawn?: SpawnFn
  /** Injectable fetch (tests); defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Readiness + overall watchdog budget. Default 15s. */
  timeoutMs?: number
}

const DEFAULT_SCRAPE_TIMEOUT_MS = 15_000
const KILL_GRACE_MS = 2_000

/** Pick an ephemeral local port by binding and releasing :0. */
function pickLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => port > 0 ? resolve(port) : reject(new Error('no ephemeral port')))
    })
  })
}

/** Kill the child (SIGTERM, then SIGKILL after a grace) and wait for exit. */
async function reap(child: PortForwardProcess): Promise<void> {
  if (child.exitCode !== undefined && child.exitCode !== null) return // already dead
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const deadline = new Promise<void>(resolve => setTimeout(resolve, KILL_GRACE_MS))
  await Promise.race([exited, deadline])
  child.kill('SIGKILL') // no-op if already dead
  await Promise.race([exited, deadline])
}

/** Wait until kubectl port-forward announces readiness (or dies trying). */
function waitForForwarding(child: PortForwardProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`port-forward exited before ready (code ${code ?? 'null'})`))
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('Forwarding from')) {
        cleanup()
        resolve()
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`port-forward not ready within ${timeoutMs}ms`))
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      child.stdout?.removeListener('data', onData)
    }
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
  })
}

/**
 * Discover the cluster's Prometheus and scrape its active targets through a
 * kubectl port-forward. Returns undefined on ANY failure — no candidate,
 * spawn error, readiness timeout, fetch error, malformed JSON — and always
 * reaps the child process. The caller treats undefined as "no monitoring
 * data", never as a scan failure.
 */
export async function scrapePrometheusTargets(
  opts: ScrapeOptions,
): Promise<{ service: string, targets: PromTarget[] } | undefined> {
  const service = findPrometheusService(opts.services)
  if (!service) return undefined
  const servicePort = service.ports.find(p => p.port === 9090)!.port
  const spawnFn = opts.spawn ?? defaultSpawn
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRAPE_TIMEOUT_MS

  let child: PortForwardProcess | undefined
  try {
    const localPort = await pickLocalPort()
    child = spawnFn([
      'kubectl', `--kubeconfig=${opts.kubeconfigPath}`,
      '-n', service.namespace,
      'port-forward', `svc/${service.name}`, `${localPort}:${servicePort}`,
    ])
    await waitForForwarding(child, timeoutMs)
    const response = await fetchFn(
      `http://127.0.0.1:${localPort}/api/v1/targets?state=active`,
      { signal: AbortSignal.timeout(timeoutMs) },
    )
    if (!response.ok) return undefined
    const targets = parseActiveTargets(await response.json())
    return { service: `${service.namespace}/${service.name}`, targets }
  } catch {
    return undefined
  } finally {
    if (child) await reap(child)
  }
}
