/**
 * Pure type definitions for @elinpf/dsh-ops-access-gate.
 *
 * Types only — no runtime values live here. The schemastery Config schema,
 * the denied-file persistence helpers, and the plugin apply stay in
 * index.ts; this module holds the contracts they operate on so consumers
 * can import them without pulling the plugin's runtime.
 *
 * @module @elinpf/dsh-ops-access-gate/types
 */

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  /** Kinds that require a grant for ANY use (no ro tier exists, e.g. ssh). */
  approvalRequiredKinds: string[]
  /** Default grant lifetime when request_access omits ttlMinutes. */
  defaultTtlMinutes: number
  /** Upper bound for a requested grant lifetime. */
  maxTtlMinutes: number
  /** JSONL audit log path; a leading ~ expands to $HOME. */
  auditFile: string
  /** TTL choices (minutes) the access panel offers — proactive grants and request decisions share this list. */
  grantTtlOptions: number[]
  /** Minutes a pending request awaits a human decision before auto-rejecting. */
  pendingRequestTimeoutMinutes: number
  /** Lockdown (deny) state file path; a leading ~ expands to $HOME. Unlike grants, lockdowns SURVIVE restarts — an incident freeze that silently lifts on restart is no freeze. */
  deniedFile: string
}

// ── Grant + service contract ─────────────────────────────────────────────────

/**
 * One authorization: session S may use elevated credentials for kind/name
 * until expiresAt. Grants are in-process only — a dsh restart clears them,
 * which is acceptable: they are short-lived by design.
 */
export interface Grant {
  /** Session id (exec.agent.id) this grant is scoped to. */
  readonly session: string
  readonly kind: string
  readonly name: string
  /** Epoch ms when the grant lapses. */
  readonly expiresAt: number
  /** The reason the model stated and the human approved. */
  readonly reason: string
  /** Who approved; 'user' via a request decision, 'panel' via the access panel. */
  readonly approvedBy: string
}

/** A live grant as reported by list (session key omitted — it is the query). */
export interface ActiveGrant {
  readonly kind: string
  readonly name: string
  readonly expiresAt: number
  readonly reason: string
  readonly approvedBy: string
}

/**
 * One operator lockdown (ticket 12, the broker's fourth state): the
 * profile is refused ENTIRELY — even ro — until lifted. Scenarios:
 * leaked credential, maintenance window, incident freeze. Lockdowns are
 * process-wide (not session-scoped) and persisted to deniedFile, so a
 * restart does not silently lift a freeze.
 */
export interface DeniedEntry {
  readonly kind: string
  readonly name: string
  /** Epoch ms of the lockdown. */
  readonly deniedAt: number
  readonly reason: string
  readonly deniedBy: string
}

/** The gate handle exposed via ctx.get('opsAccessGate'). */
export interface OpsAccessGate {
  /** Record a grant. Re-authorizing the same (session, kind, name) replaces the entry. */
  authorize(grant: Grant): void
  /** Whether this session holds an unexpired grant for the profile (the broker's query). */
  isAuthorized(session: string, kind: string, name: string): boolean
  /** Drop a grant immediately. Returns false when no such grant existed. */
  revoke(session: string, kind: string, name: string): boolean
  /** This session's live (unexpired) grants. */
  list(session: string): ActiveGrant[]
  /** Every session's live grants, for the cross-session overview (ticket 13). */
  listAll(): Array<ActiveGrant & { session: string }>
  /**
   * Lock a profile outright: even ro resolution is refused until lifted.
   * Also revokes every live grant for it across ALL sessions (a leaked
   * credential's elevation must die now) and returns the affected
   * session ids so the caller can notify them. Re-denying replaces the
   * entry (fresh reason/timestamp).
   */
  deny(kind: string, name: string, reason: string, deniedBy: string): string[]
  /** Lift a lockdown. Returns false when the profile was not locked. */
  undeny(kind: string, name: string): boolean
  /** Whether the profile is operator-locked (the broker's first check). */
  isDenied(kind: string, name: string): boolean
  /** All active lockdowns, for the access panel. */
  listDenied(): DeniedEntry[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsAccessGate?: OpsAccessGate
  }
}

// ── Pending requests (the self-built approval channel, ADR-0004) ─────────────

/** One parked request_access call awaiting a human decision in the panel. */
export interface PendingRequest {
  readonly id: string
  readonly session: string
  /** The dispatching session, when the requester is a spawned sub-agent (血缘). */
  readonly parentSession?: string
  readonly kind: string
  readonly name: string
  readonly requestedTtlMinutes: number
  readonly reason: string
  readonly createdAt: number
  /** Epoch ms when the request auto-rejects (timeout). */
  readonly decidesAt: number
}

/** How a pending request settles. Approved carries the human-chosen TTL. */
export type RequestDecision =
  | { readonly approved: true; readonly ttlMinutes: number }
  | { readonly approved: false; readonly outcome: 'rejected' | 'timeout' | 'cancelled' }
