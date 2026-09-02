/**
 * Cluster scanner — the read side of the environment inventory.
 *
 * Runs `kubectl --kubeconfig <path> get ... -o json` for workloads
 * (deploy/sts/ds), services, ingresses, configmaps, and secrets, and reduces
 * the responses to a {@link ClusterScan} of plain data. No files are written
 * here; classification and persistence live elsewhere.
 *
 * Security discipline (hard rules):
 * - Secrets are read metadata-only: the kubectl call selects only
 *   namespace/name via jsonpath, so `data`/`stringData` never enters the
 *   process, let alone the inventory.
 * - The kubeconfig path never appears in thrown errors — kubectl echoes it
 *   in stderr, so every error is scrubbed before it propagates.
 * - Container env values: only literal `value` entries are captured;
 *   `valueFrom` contributes reference names (configMapKeyRef/secretKeyRef),
 *   never resolved values.
 *
 * @module @elinpf/dsh-ops-tool-environment
 */

import { spawn } from 'node:child_process'
import { scrapePrometheusTargets } from './prometheus.js'
import type { SpawnFn } from './prometheus.js'
import type {
  CephHints,
  ClusterScan,
  ScannedConfigMap,
  ScannedEndpoints,
  ScannedIngress,
  ScannedSecret,
  ScannedService,
  ScannedWorkload,
} from './types.js'

/** Injectable command runner: argv (no shell) -> captured stdout. Throws on failure. */
export type ExecFn = (args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string }>

export const SCAN_TIMEOUT_MS = 30_000

/** A cluster scan failure. The message is always kubeconfig-path-scrubbed. */
export class ScanError extends Error {
  constructor(
    message: string,
    /** The cluster profile id this failure belongs to. */
    readonly cluster: string,
  ) {
    super(message)
    this.name = 'ScanError'
  }
}

/** Default runner: spawn kubectl with argv, capture stdout/stderr, 30s timeout. */
export const defaultExec: ExecFn = (args, { timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error(`command timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.on('error', (err) => {
    clearTimeout(timer)
    reject(err)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (code === 0) {
      resolve({ stdout: Buffer.concat(stdout).toString('utf8') })
    } else {
      reject(new Error(`kubectl exited with code ${code ?? 'null'}: ${Buffer.concat(stderr).toString('utf8').trim()}`))
    }
  })
})

export interface ScanClusterInput {
  /** Cluster profile id — the only cluster identity that appears in output. */
  cluster: string
  /** Real kubeconfig path. Used in argv only; never surfaced in output/errors. */
  kubeconfigPath: string
  /** Injectable exec for tests; defaults to spawning kubectl. */
  exec?: ExecFn
  /** Injectable port-forward spawn (tests); defaults to node:child_process. */
  spawn?: SpawnFn
  /** Injectable fetch (tests); defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Scan timestamp; defaults to now (injectable for deterministic tests). */
  now?: Date
  /** Per-kubectl-call timeout (ms); defaults to SCAN_TIMEOUT_MS. */
  timeoutMs?: number
  /** Prometheus scrape timeout (ms); defaults to the scrape's own 15s. */
  prometheusTimeoutMs?: number
}

/** Replace every occurrence of the kubeconfig path with a display token. */
export function scrubKubeconfigPath(text: string, kubeconfigPath: string): string {
  return text.split(kubeconfigPath).join('<kubeconfig>')
}

interface K8sList {
  items?: Array<Record<string, any>>
}

function parseList(json: string, what: string): K8sList {
  try {
    const doc = JSON.parse(json) as K8sList
    if (!doc || !Array.isArray(doc.items)) throw new Error('missing .items')
    return doc
  } catch (err) {
    throw new Error(`cannot parse ${what} response: ${(err as Error).message}`)
  }
}

function asLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function reduceWorkload(kind: ScannedWorkload['kind'], item: Record<string, any>): ScannedWorkload {
  const meta = item.metadata ?? {}
  const podSpec = item.spec?.template?.spec ?? {}
  const containers = [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? [])]
  const images: string[] = []
  const env: Record<string, string> = {}
  const configMapRefs = new Set<string>()
  const secretRefs = new Set<string>()
  for (const container of containers) {
    if (typeof container.image === 'string') images.push(container.image)
    for (const entry of container.env ?? []) {
      // Literal values only — valueFrom entries contribute reference names below.
      if (typeof entry?.name === 'string' && typeof entry?.value === 'string') {
        env[entry.name] = entry.value
      }
      const cmKeyRef = entry?.valueFrom?.configMapKeyRef
      if (typeof cmKeyRef?.name === 'string') configMapRefs.add(cmKeyRef.name)
      const secretKeyRef = entry?.valueFrom?.secretKeyRef
      if (typeof secretKeyRef?.name === 'string') secretRefs.add(secretKeyRef.name)
    }
    for (const from of container.envFrom ?? []) {
      if (typeof from?.configMapRef?.name === 'string') configMapRefs.add(from.configMapRef.name)
      // Secret reference: record the NAME only. Values are never touched.
      if (typeof from?.secretRef?.name === 'string') secretRefs.add(from.secretRef.name)
    }
  }
  return {
    kind,
    namespace: meta.namespace ?? 'default',
    name: meta.name ?? '',
    images,
    labels: asLabels(meta.labels),
    podLabels: asLabels(item.spec?.template?.metadata?.labels),
    env,
    configMapRefs: [...configMapRefs].sort(),
    secretRefs: [...secretRefs].sort(),
  }
}

function reduceService(item: Record<string, any>): ScannedService {
  const meta = item.metadata ?? {}
  const spec = item.spec ?? {}
  const ports = (spec.ports ?? []).map((p: any) => {
    const port: { port: number, targetPort?: number | string, name?: string } = { port: p?.port }
    if (p?.targetPort !== undefined) port.targetPort = p.targetPort
    if (typeof p?.name === 'string') port.name = p.name
    return port
  }).filter((p: { port: number }) => typeof p.port === 'number')
  const selector = spec.selector && Object.keys(spec.selector).length > 0 ? asLabels(spec.selector) : null
  const svc: ScannedService = {
    namespace: meta.namespace ?? 'default',
    name: meta.name ?? '',
    type: spec.type ?? 'ClusterIP',
    ports,
    selector,
    labels: asLabels(meta.labels),
  }
  if (typeof spec.clusterIP === 'string' && spec.clusterIP !== 'None') svc.clusterIP = spec.clusterIP
  if (typeof spec.externalName === 'string') svc.externalName = spec.externalName
  return svc
}

function reduceIngress(item: Record<string, any>): ScannedIngress {
  const meta = item.metadata ?? {}
  const hosts = new Set<string>()
  const serviceBackends: Array<{ serviceName: string, servicePort?: number | string }> = []
  for (const rule of item.spec?.rules ?? []) {
    if (typeof rule?.host === 'string') hosts.add(rule.host)
    for (const path of rule?.http?.paths ?? []) {
      const svc = path?.backend?.service
      if (typeof svc?.name !== 'string') continue
      const backend: { serviceName: string, servicePort?: number | string } = { serviceName: svc.name }
      const port = svc.port?.number ?? svc.port?.name
      if (port !== undefined) backend.servicePort = port
      serviceBackends.push(backend)
    }
  }
  return {
    namespace: meta.namespace ?? 'default',
    name: meta.name ?? '',
    hosts: [...hosts].sort(),
    serviceBackends,
  }
}

function reduceConfigMap(item: Record<string, any>): ScannedConfigMap {
  const meta = item.metadata ?? {}
  const data: Record<string, string> = {}
  for (const [k, v] of Object.entries(item.data ?? {})) {
    if (typeof v === 'string') data[k] = v
  }
  return { namespace: meta.namespace ?? 'default', name: meta.name ?? '', data }
}

/** Endpoints reduced to ready-address count (subsets[].addresses; notReady excluded). */
function reduceEndpoints(item: Record<string, any>): ScannedEndpoints {
  const meta = item.metadata ?? {}
  let addresses = 0
  for (const subset of item.subsets ?? []) {
    addresses += (subset?.addresses ?? []).length
  }
  return { namespace: meta.namespace ?? 'default', name: meta.name ?? '', addresses }
}

/**
 * Metadata-only Secret list. The scanner asks kubectl for a jsonpath of
 * `namespace<TAB>name` per item so Secret data never crosses into this
 * process. Malformed lines are skipped (best-effort, never fatal).
 */
function parseSecretNames(output: string): ScannedSecret[] {
  const secrets: ScannedSecret[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const tab = trimmed.indexOf('\t')
    if (tab <= 0) continue
    secrets.push({ namespace: trimmed.slice(0, tab), name: trimmed.slice(tab + 1) })
  }
  return secrets
}

const SECRETS_JSONPATH = '{range .items[*]}{.metadata.namespace}{\'\\t\'}{.metadata.name}{\'\\n\'}{end}'

/**
 * Scan one cluster. All resource reads run against the same kubeconfig; any
 * failure (unreachable cluster, timeout, malformed response) rejects with a
 * ScanError whose message never contains the kubeconfig path.
 */
export async function scanCluster(input: ScanClusterInput): Promise<ClusterScan> {
  const exec = input.exec ?? defaultExec
  const base = ['kubectl', `--kubeconfig=${input.kubeconfigPath}`]
  const run = async (args: string[]) => {
    try {
      return await exec([...base, ...args], { timeoutMs: input.timeoutMs ?? SCAN_TIMEOUT_MS })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ScanError(scrubKubeconfigPath(message, input.kubeconfigPath), input.cluster)
    }
  }
  const parseOrThrow = (json: string, what: string) => {
    try {
      return parseList(json, what)
    } catch (err) {
      throw new ScanError((err as Error).message, input.cluster)
    }
  }

  const [workloads, services, ingresses, configMaps] = await Promise.all([
    run(['get', 'deployments,statefulsets,daemonsets', '--all-namespaces', '-o', 'json']),
    run(['get', 'services', '--all-namespaces', '-o', 'json']),
    run(['get', 'ingresses', '--all-namespaces', '-o', 'json']),
    run(['get', 'configmaps', '--all-namespaces', '-o', 'json']),
  ])
  // Secrets are metadata-only reference names — nice to have, not worth
  // failing a cluster over: the k8s `view` ClusterRole does NOT include
  // secrets, so a strict ro account gets Forbidden here. The workload
  // secretRefs (from pod specs) already carry the reference names.
  const secrets = await run(['get', 'secrets', '--all-namespaces', '-o', `jsonpath=${SECRETS_JSONPATH}`])
    .catch(() => ({ stdout: '' }))
  // Endpoints feed the backend-less-Service anomaly detector. Same degraded
  // discipline: a failed read yields undefined and the detector skips —
  // never a guess, never a scan failure.
  const endpointsRaw = await run(['get', 'endpoints', '--all-namespaces', '-o', 'json'])
    .catch(() => undefined)
  // rook-ceph footprint (ticket 15): CephBlockPool/CephCluster CRs and the
  // rook-ceph-tools pod location. Same degraded discipline as endpoints —
  // CRDs absent or the ro account unable to list them (built-in `view`
  // covers no ceph.rook.io resources) yields no hints, never a scan failure.
  const cephCrsRaw = await run(['get', 'cephclusters.ceph.rook.io,cephblockpools.ceph.rook.io', '--all-namespaces', '-o', 'json'])
    .catch(() => undefined)
  const cephToolsRaw = await run(['get', 'pods', '--all-namespaces', '-l', 'app=rook-ceph-tools', '-o', `jsonpath=${SECRETS_JSONPATH}`])
    .catch(() => undefined)

  const workloadItems: ScannedWorkload[] = []
  // A combined `get a,b,c -o json` returns a single List whose items mix kinds.
  for (const item of parseOrThrow(workloads.stdout, 'workloads').items ?? []) {
    const kind = item?.kind
    if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
      workloadItems.push(reduceWorkload(kind, item))
    }
  }

  const serviceItems = (parseOrThrow(services.stdout, 'services').items ?? []).map(reduceService)

  // Prometheus corroboration: best-effort enhancement. Any failure (no
  // Prometheus service, port-forward timeout, unreachable API) yields
  // undefined — the main scan result is unaffected and the cluster is NOT
  // marked stale for this.
  let prometheus: ClusterScan['prometheus']
  try {
    prometheus = await scrapePrometheusTargets({
      kubeconfigPath: input.kubeconfigPath,
      services: serviceItems,
      spawn: input.spawn,
      fetchFn: input.fetchFn,
      ...(input.prometheusTimeoutMs !== undefined ? { timeoutMs: input.prometheusTimeoutMs } : {}),
    })
  } catch {
    prometheus = undefined
  }

  const scan: ClusterScan = {
    cluster: input.cluster,
    scannedAt: (input.now ?? new Date()).toISOString(),
    workloads: workloadItems,
    services: serviceItems,
    ingresses: (parseOrThrow(ingresses.stdout, 'ingresses').items ?? []).map(reduceIngress),
    configMaps: (parseOrThrow(configMaps.stdout, 'configmaps').items ?? []).map(reduceConfigMap),
    secrets: parseSecretNames(secrets.stdout),
  }
  if (endpointsRaw !== undefined) {
    scan.endpoints = (parseOrThrow(endpointsRaw.stdout, 'endpoints').items ?? []).map(reduceEndpoints)
  }

  // Fold the ceph hints: emit only when something was actually found.
  let ceph: CephHints | undefined
  if (cephCrsRaw !== undefined) {
    const pools: CephHints['pools'] = []
    const clusters: CephHints['clusters'] = []
    for (const item of parseOrThrow(cephCrsRaw.stdout, 'ceph CRs').items ?? []) {
      const ns = item?.metadata?.namespace
      const nm = item?.metadata?.name
      if (typeof ns !== 'string' || typeof nm !== 'string') continue
      if (item.kind === 'CephBlockPool') pools.push({ namespace: ns, name: nm })
      else if (item.kind === 'CephCluster') clusters.push({ namespace: ns, name: nm })
    }
    if (pools.length + clusters.length > 0) ceph = { pools, clusters }
  }
  // The tools-pod read reuses the namespace<TAB>name reduction (metadata only).
  const toolsPods = cephToolsRaw !== undefined ? parseSecretNames(cephToolsRaw.stdout) : []
  if (toolsPods.length > 0) {
    ceph = ceph ?? { pools: [], clusters: [] }
    ceph.toolsPod = toolsPods[0]
  }
  if (ceph !== undefined) scan.ceph = ceph
  if (prometheus !== undefined) scan.prometheus = prometheus
  return scan
}
