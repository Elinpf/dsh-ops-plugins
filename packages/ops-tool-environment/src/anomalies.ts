/**
 * Anomaly detection over a scanned cluster (spec 0003 follow-up).
 *
 * Two deterministic detectors, both built on generic k8s semantics only —
 * namespace string comparison and selector/endpoints agreement. Nothing
 * here knows any environment's names; the same rules must flag (or stay
 * silent on) any cluster shape.
 *
 * - `cross-namespace-ref` (info): a uses-service/uses-middleware edge whose
 *   Service lives in a different namespace than the referencing workload.
 *   Often legitimate (shared infrastructure), but a prime suspect when an
 *   environment behaves like another one — the classic "e2e pointing at the
 *   wrong namespace's database".
 * - `service-no-backend` (warning): a Service with a pod selector whose
 *   Endpoints object has ZERO ready addresses (or no Endpoints at all).
 *   Endpoints are k8s' own authoritative answer to "does this Service have
 *   backends" — preferred over inferring from fronts edges, which cannot
 *   distinguish "selector matches nothing" from "pods exist but are not
 *   ready / not in the scanned set".
 *
 * @module @elinpf/dsh-ops-tool-environment
 */

import type {
  Anomaly,
  RelationEdge,
  ResourceRef,
  ScannedEndpoints,
  ScannedService,
} from './types.js'

export interface DetectAnomaliesInput {
  edges: RelationEdge[]
  services: ScannedService[]
  /** Undefined when the endpoints read failed — the no-backend detector then skips. */
  endpoints?: ScannedEndpoints[]
}

function ref(kind: string, namespace: string, name: string): ResourceRef {
  return { kind, namespace, name }
}

/** All detected anomalies, deterministically ordered. Never throws. */
export function detectAnomalies(input: DetectAnomaliesInput): Anomaly[] {
  try {
    const anomalies: Anomaly[] = []

    // ── Cross-namespace references ──────────────────────────────────────────
    const seenCross = new Set<string>()
    for (const edge of input.edges) {
      if (edge.kind !== 'uses-service' && edge.kind !== 'uses-middleware') continue
      if (edge.from.namespace === edge.to.namespace) continue
      const id = `${edge.from.namespace}/${edge.from.name}→${edge.to.namespace}/${edge.to.name}`
      if (seenCross.has(id)) continue
      seenCross.add(id)
      anomalies.push({
        kind: 'cross-namespace-ref',
        severity: 'info',
        ref: ref(edge.from.kind, edge.from.namespace, edge.from.name),
        related: ref('Service', edge.to.namespace, edge.to.name),
        message: `${edge.from.namespace}/${edge.from.name} references Service ${edge.to.namespace}/${edge.to.name} across namespaces`,
      })
    }

    // ── Services with a selector but no ready backends ─────────────────────
    // Only runs on real endpoints data; a failed read must not fabricate
    // anomalies.
    if (input.endpoints !== undefined) {
      const endpointsByKey = new Map(input.endpoints.map(e => [`${e.namespace}/${e.name}`, e]))
      for (const svc of input.services) {
        if (svc.selector === null) continue // selector-less (ExternalName/manual) has no backend contract
        const ep = endpointsByKey.get(`${svc.namespace}/${svc.name}`)
        if (ep !== undefined && ep.addresses > 0) continue
        anomalies.push({
          kind: 'service-no-backend',
          severity: 'warning',
          ref: ref('Service', svc.namespace, svc.name),
          message: `Service ${svc.namespace}/${svc.name} has a selector but no ready endpoints (no backend pods)`,
        })
      }
    }

    anomalies.sort((a, b) =>
      a.kind.localeCompare(b.kind)
      || a.ref.namespace.localeCompare(b.ref.namespace)
      || a.ref.name.localeCompare(b.ref.name))
    return anomalies
  } catch {
    // Best-effort by contract: detection must never break the inventory.
    return []
  }
}
