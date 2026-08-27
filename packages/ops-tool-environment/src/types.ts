/**
 * Shared shapes for the environment inventory scanner core.
 *
 * Data flow: scanCluster (raw k8s reads) -> ClusterScan; buildClusterInventory
 * (classification + relations) -> ClusterInventory; inventory.ts persists
 * ClusterInventory per cluster section. Everything here is plain data —
 * no credential paths, no Secret values ever appear in these shapes.
 *
 * @module @deepseek-ai/dsh-ops-tool-environment
 */

/** Reference to a namespaced k8s object. */
export interface ResourceRef {
  kind: string
  namespace: string
  name: string
}

/** A workload (Deployment / StatefulSet / DaemonSet) reduced to scan-relevant fields. */
export interface ScannedWorkload {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'
  namespace: string
  name: string
  /** All container images (init containers included), as written in the spec. */
  images: string[]
  /** Workload metadata labels. */
  labels: Record<string, string>
  /** Pod template labels — the set a Service selector matches against. */
  podLabels: Record<string, string>
  /** Plaintext env values only: { VAR: value }. valueFrom entries never appear here. */
  env: Record<string, string>
  /** ConfigMap names referenced via envFrom.configMapRef or env.valueFrom.configMapKeyRef. */
  configMapRefs: string[]
  /** Secret names referenced via envFrom.secretRef or env.valueFrom.secretKeyRef — names only, never values. */
  secretRefs: string[]
}

export interface ScannedService {
  namespace: string
  name: string
  /** ClusterIP / NodePort / LoadBalancer / ExternalName. */
  type: string
  clusterIP?: string
  externalName?: string
  ports: Array<{ port: number, targetPort?: number | string, name?: string }>
  /** Pod selector; null for selector-less Services (external endpoints). */
  selector: Record<string, string> | null
  labels: Record<string, string>
}

export interface ScannedIngress {
  namespace: string
  name: string
  hosts: string[]
  /** Service backends referenced by the rules. */
  serviceBackends: Array<{ serviceName: string, servicePort?: number | string }>
}

export interface ScannedConfigMap {
  namespace: string
  name: string
  /** Plain configuration — ConfigMap data is non-secret by design. */
  data: Record<string, string>
}

/** Secret metadata only. The scanner never requests `data`/`stringData`. */
export interface ScannedSecret {
  namespace: string
  name: string
}

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

/** Raw read of one cluster — the scanner's output before classification. */
export interface ClusterScan {
  /** Cluster profile id (the ops-access registry key), never a path. */
  cluster: string
  /** ISO timestamp of the scan. */
  scannedAt: string
  workloads: ScannedWorkload[]
  services: ScannedService[]
  ingresses: ScannedIngress[]
  configMaps: ScannedConfigMap[]
  secrets: ScannedSecret[]
  /**
   * Prometheus corroboration, when a Prometheus service was discovered and
   * scraped (undefined otherwise — enhancement, never a hard dependency).
   */
  prometheus?: { service: string, targets: PromTarget[] }
}

/** A workload after classification. `type` is a middleware name, 'infra', or 'unknown'. */
export interface ClassifiedWorkload extends ScannedWorkload {
  type: string
  /** Prometheus up/down counts, when the cluster has a scrapable Prometheus. */
  monitoring?: MonitoringStatus
}

/** A recognized middleware instance: workload + the Services fronting it. */
export interface MiddlewareInstance {
  /** Middleware type from the classification table (e.g. 'redis', 'mysql'). */
  type: string
  namespace: string
  /** Workload name. */
  workload: string
  workloadKind: string
  images: string[]
  /** Names of Services whose selector matches this instance's pod labels. */
  serviceEntries: string[]
  /** Prometheus up/down counts, when available. */
  monitoring?: MonitoringStatus
}

/**
 * A best-effort relation edge.
 *
 * - `uses-service`      workload -> Service (found a svc FQDN in env/ConfigMap values)
 * - `fronts`            Service -> workload (Service selector matches pod labels)
 * - `uses-middleware`   workload -> middleware instance (uses-service + fronts composed)
 * - `references-secret` workload -> Secret (envFrom/env secretRef; the name only)
 */
export interface RelationEdge {
  kind: 'uses-service' | 'fronts' | 'uses-middleware' | 'references-secret'
  from: ResourceRef
  to: ResourceRef
  /** Where the link was seen, e.g. 'env:PG_HOST' or 'configmap:baizeops-config:PG_HOST'. */
  via: string
  /** Middleware type, set on uses-middleware edges. */
  targetType?: string
}

/** The per-cluster section that lands in environment.yaml. */
export interface ClusterInventory {
  /** ISO timestamp of the scan that produced this section. */
  scannedAt: string
  /** Middleware instances recognized by the classification table. */
  middleware: MiddlewareInstance[]
  /**
   * Every scanned workload with its classification. Workloads with
   * type 'unknown' are the unknown bucket — listed, never dropped.
   */
  workloads: ClassifiedWorkload[]
  services: ScannedService[]
  ingresses: ScannedIngress[]
  edges: RelationEdge[]
  /** The Prometheus service this cluster's monitoring data came from. */
  prometheusService?: string
}
