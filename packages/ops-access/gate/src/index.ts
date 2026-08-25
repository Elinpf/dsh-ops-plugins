/**
 * Ops access gate — per-session credential brokering.
 *
 * This plugin owns the **authorization ledger**: an in-process map keyed by
 * session id (`exec.agent.id`). It registers a **pure-decision broker** into
 * the ops-access seam via {@link registerAccessBroker}; that broker answers
 * `'rw'` when the calling session holds an unexpired grant for the profile,
 * `'ro'` otherwise. Core then serves the profile from the matching registry
 * file (ro → access.yaml, rw → access-rw.yaml). The gate never sees
 * credential fields — kind, profile name, and session id are its whole world.
 *
 * Scope of this package (issue 01): the ledger, the broker, session-keyed
 * isolation, and the fail-closed guarantee (no agent → core serves ro, never
 * rw). Grant *creation* (the `request_access` approval flow), TTL expiry,
 * manual revoke, ssh denial, and the audit log land in a follow-up.
 *
 * @module @deepseek-ai/dsh-ops-access-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AccessBroker } from '@deepseek-ai/dsh-ops-access'
import { registerAccessBroker } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-gate'

export const inject: string[] = []

export const Config = z.object({})

// ── Grant + service contract ─────────────────────────────────────────────────

/**
 * One authorization: session S may use rw credentials for `kind`/`name`.
 * Grants are short-lived and in-process only — a dsh restart clears them,
 * which is acceptable under the threat model (issue 01 scope: presence only;
 * TTL/approver/reason are added by the request_access flow).
 */
export interface Grant {
  /** Session id (`exec.agent.id`) this grant is scoped to. */
  readonly session: string
  readonly kind: string
  readonly name: string
}

/** The gate handle exposed via ctx.get('opsAccessGate'). */
export interface OpsAccessGate {
  /**
   * Record a grant. Idempotent for the same (session, kind, name) — recording
   * twice does not extend or duplicate. Used by the `request_access` approval
   * flow; tests inject grants directly.
   */
  authorize(grant: Grant): void
  /** Whether this session holds a grant for the profile (the broker's query). */
  isAuthorized(session: string, kind: string, name: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsAccessGate?: OpsAccessGate
  }
}

// ── Ledger ────────────────────────────────────────────────────────────────────

/**
 * Per-session grants. Preset-plane shared instance → keyed by session id, not
 * closure state. Each session maps to a Set of `kind\0name` keys, computed
 * once at authorize time so the per-resolve `isAuthorized` is a single
 * `Set.has` (O(1), no per-call string concat) — it runs on every profiled
 * shell call via the broker, hence on the resolve hot path.
 */
type Ledger = Map<string, Set<string>>

/** Stable key for a (kind, name) pair within one session's grant set. */
function grantKey(kind: string, name: string): string {
  return `${kind}\0${name}`
}

function makeGate(ledger: Ledger): OpsAccessGate {
  return {
    authorize(grant: Grant): void {
      let set = ledger.get(grant.session)
      if (!set) ledger.set(grant.session, set = new Set())
      set.add(grantKey(grant.kind, grant.name))
    },
    isAuthorized(session: string, kind: string, name: string): boolean {
      return ledger.get(session)?.has(grantKey(kind, name)) ?? false
    },
  }
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  const ledger: Ledger = new Map()
  const gate = makeGate(ledger)
  ctx.provide('opsAccessGate', gate)

  // The broker is a pure decision function. Core only calls it when a broker
  // is registered AND an agent was supplied — so `agent` is always present
  // here; the agent-missing (fail-closed → ro) case is handled by core before
  // this function is ever reached.
  const broker: AccessBroker = (kind, name, agent) =>
    gate.isAuthorized(agent.id, kind, name) ? 'rw' : 'ro'
  registerAccessBroker(ctx, broker)
}
