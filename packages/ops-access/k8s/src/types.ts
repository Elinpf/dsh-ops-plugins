/**
 * Type definitions for the ops-access-k8s plugin.
 *
 * Types only — no runtime values live here.
 *
 * @module @deepseek-ai/dsh-ops-access-k8s/types
 */

/** Live verdicts for the operationally interesting faces (ticket 10); null = the check could not run. */
export interface K8sProbeFacets {
  servicesProxy: boolean | null
  podsExec: boolean | null
}
