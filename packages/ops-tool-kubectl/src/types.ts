/**
 * Type definitions for @elinpf/dsh-ops-kubectl.
 *
 * Types-only module — no runtime values. Re-exported from the plugin entry
 * so existing imports keep working.
 *
 * @module @elinpf/dsh-ops-kubectl/types
 */

// ── list_access types ────────────────────────────────────────────────────────

/** One list_access entry: envelope fields + tier readiness, never `fields`. */
export interface ListedProfile {
  name: string
  displayName?: string
  description?: string
  environment?: string
  /** Whether the ro tier resolves (the agent's default working level). */
  ro: boolean
  /** Whether the rw tier resolves (grant-gated; source for ro derivation). */
  rw: boolean
  /** Capability-probe annotation per ok tier (ticket 10), e.g. 'ro 已核验 / rw 声明未核验'. */
  probe?: string
}

export interface ListAccessResult {
  groups: Array<{ kind: string, profiles: ListedProfile[] }>
  total: number
  /** Present when called with help: true — the registry management doc. */
  help?: string
}
