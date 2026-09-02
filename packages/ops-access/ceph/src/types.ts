/**
 * Type definitions for the ops-access-ceph provider plugin.
 *
 * Types only — no runtime code lives here. Provider values (schema, probe
 * functions, plugin apply) stay in index.ts.
 *
 * @module @elinpf/dsh-ops-access-ceph
 */

// ── Capability probe outcomes (ticket 10) ────────────────────────────────────

/**
 * Result of the pure caps-vs-tier assessment: the entity's real caps either
 * verify the claimed tier or mismatch it.
 */
export interface CapAssessment {
  status: 'verified' | 'mismatch'
  detail?: string
}

/**
 * A classified probe failure: the probe itself could not run (cluster
 * unreachable, ceph CLI missing, or a tight ro entity that cannot self-read
 * its caps). Always 'unverifiable' — never a rejection.
 */
export interface ProbeFailure {
  status: 'unverifiable'
  detail: string
}

/** Outcome of a save-time capability probe. */
export type ProbeOutcome = CapAssessment | ProbeFailure
