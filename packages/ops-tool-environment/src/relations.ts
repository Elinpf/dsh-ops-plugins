/**
 * Best-effort relation edges between scanned resources.
 *
 * Sources of truth, in order of strength:
 *
 * - `fronts` — a Service whose pod selector is a subset of a workload's pod
 *   template labels fronts that workload. Deterministic, from k8s itself.
 * - `uses-service` — a literal `env` value or a data value of a referenced
 *   ConfigMap contains a `<name>.<namespace>.svc[.cluster.local]` address
 *   that resolves to a scanned Service.
 * - `uses-middleware` — composition of the two above: a workload that uses
 *   a Service which fronts a recognized middleware instance.
 * - `references-secret` — envFrom/valueFrom secret references, NAME only.
 *   Secret values are never read anywhere in this package.
 *
 * Everything here is best-effort: a value that parses to nothing produces
 * no edge and no error. A missing ConfigMap, a dangling Service name, a
 * selector-less Service — all simply yield no edge.
 *
 * @module @deepseek-ai/dsh-ops-tool-environment
 */

import { isMiddlewareType } from './classify.js'
import type {
  ClassifiedWorkload,
  ClusterScan,
  RelationEdge,
  ResourceRef,
  ScannedService,
} from './types.js'

/**
 * Matches `<name>.<namespace>.svc` and `<name>.<namespace>.svc.cluster.local`
 * inside arbitrary text (URLs, JDBC strings, bare hosts). Only the
 * namespace-qualified forms — the short in-namespace form is too ambiguous.
 */
const SVC_PATTERN = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.svc(?:\.cluster\.local)?\b/gi

function workloadRef(w: { kind: string, namespace: string, name: string }): ResourceRef {
  return { kind: w.kind, namespace: w.namespace, name: w.name }
}

function serviceRef(s: { namespace: string, name: string }): ResourceRef {
  return { kind: 'Service', namespace: s.namespace, name: s.name }
}

function keyOf(ref: ResourceRef): string {
  return `${ref.kind}/${ref.namespace}/${ref.name}`
}

/** Extract distinct (name, namespace) Service addresses mentioned in a text value. */
export function findServiceAddresses(value: string): Array<{ name: string, namespace: string }> {
  const found = new Map<string, { name: string, namespace: string }>()
  for (const match of value.matchAll(SVC_PATTERN)) {
    const name = match[1].toLowerCase()
    const namespace = match[2].toLowerCase()
    found.set(`${namespace}/${name}`, { name, namespace })
  }
  return [...found.values()]
}

/** A Service fronts a workload when its selector is a subset of the pod template labels. */
function selectorMatches(selector: Record<string, string>, podLabels: Record<string, string>): boolean {
  return Object.entries(selector).every(([k, v]) => podLabels[k] === v)
}

export interface BuildRelationsInput {
  scan: ClusterScan
  /** Workloads after classification — used to compose uses-middleware edges. */
  classified: ClassifiedWorkload[]
}

/** Derive all relation edges for one scanned cluster. Never throws. */
export function buildRelations(input: BuildRelationsInput): RelationEdge[] {
  try {
    const { scan, classified } = input
    const edges: RelationEdge[] = []
    const seen = new Set<string>()
    const push = (edge: RelationEdge) => {
      const id = `${edge.kind}|${keyOf(edge.from)}|${keyOf(edge.to)}|${edge.via}`
      if (!seen.has(id)) {
        seen.add(id)
        edges.push(edge)
      }
    }

    const servicesByKey = new Map<string, ScannedService>()
    for (const svc of scan.services) servicesByKey.set(keyOf(serviceRef(svc)), svc)

    // Service -> workload ownership edges, and the reverse index for composition.
    const frontsByService = new Map<string, ClassifiedWorkload[]>()
    for (const svc of scan.services) {
      if (!svc.selector) continue
      for (const w of classified) {
        if (w.namespace !== svc.namespace) continue
        if (!selectorMatches(svc.selector, w.podLabels)) continue
        push({ kind: 'fronts', from: serviceRef(svc), to: workloadRef(w), via: 'selector' })
        const list = frontsByService.get(keyOf(serviceRef(svc))) ?? []
        list.push(w)
        frontsByService.set(keyOf(serviceRef(svc)), list)
      }
    }

    const configMapsByKey = new Map(scan.configMaps.map(cm => [`${cm.namespace}/${cm.name}`, cm]))

    for (const w of classified) {
      const from = workloadRef(w)

      // Plaintext env values.
      for (const [key, value] of Object.entries(w.env)) {
        for (const addr of findServiceAddresses(value)) {
          const svc = servicesByKey.get(`Service/${addr.namespace}/${addr.name}`)
          if (!svc) continue
          push({ kind: 'uses-service', from, to: serviceRef(svc), via: `env:${key}` })
        }
      }

      // Data values of ConfigMaps this workload references.
      for (const cmName of w.configMapRefs) {
        const cm = configMapsByKey.get(`${w.namespace}/${cmName}`)
        if (!cm) continue
        for (const [key, value] of Object.entries(cm.data)) {
          for (const addr of findServiceAddresses(value)) {
            const svc = servicesByKey.get(`Service/${addr.namespace}/${addr.name}`)
            if (!svc) continue
            push({ kind: 'uses-service', from, to: serviceRef(svc), via: `configmap:${cmName}:${key}` })
          }
        }
      }

      // Secret references — the name only, never a value.
      for (const secretName of w.secretRefs) {
        push({
          kind: 'references-secret',
          from,
          to: { kind: 'Secret', namespace: w.namespace, name: secretName },
          via: 'secretRef',
        })
      }
    }

    // Compose: workload uses a Service that fronts a middleware instance.
    const middlewareTypes = new Map<string, string>()
    for (const w of classified) {
      if (isMiddlewareType(w.type)) middlewareTypes.set(keyOf(workloadRef(w)), w.type)
    }
    for (const edge of edges.filter(e => e.kind === 'uses-service')) {
      for (const instance of frontsByService.get(keyOf(edge.to)) ?? []) {
        const type = middlewareTypes.get(keyOf(workloadRef(instance)))
        if (!type) continue
        push({
          kind: 'uses-middleware',
          from: edge.from,
          to: workloadRef(instance),
          via: edge.via,
          targetType: type,
        })
      }
    }

    return edges
  } catch {
    // Best-effort by contract: a malformed scan must never break the inventory.
    return []
  }
}
