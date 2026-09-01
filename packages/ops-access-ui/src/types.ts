/**
 * Pure wire types for @deepseek-ai/dsh-ops-access-ui.
 *
 * These mirror the HTTP routes served by the ops-access core package
 * (preset plane): the @-mention list route, the admin routes, and the
 * access-gate's human-side panel routes. Types only — no runtime values;
 * the client half imports them (erased at bundle time) and re-exports the
 * public group for compatibility.
 *
 * @module @deepseek-ai/dsh-ops-access-ui/types
 */

// ── @-mention wire shape (mirrors GET /ops-access/list in ops-access core) ──

export interface AccessMentionCandidate {
  kind: string
  name: string
  description?: string
  environment?: string
  /** Tier readiness — entries with only an rw tier still appear (ro derivable). */
  ro: boolean
  rw: boolean
  /** Per-tier probe verdicts for ok tiers, when the provider probes (ticket 10). */
  probe?: { ro?: string, rw?: string }
  mention: string
}

// ── Admin wire shapes (mirrors the admin routes in ops-access core) ─────────

/** One entry in the merged admin view: envelope + per-tier validation, never fields. */
export interface AdminEntry {
  kind: string
  /** Stable id (registry key). */
  name: string
  /** envelope.name is the editable display label. */
  envelope: { name?: string, description?: string, environment?: string }
  tiers: { ro: AdminTierStatus, rw: AdminTierStatus }
}

/** Validation status of one entry in one tier. */
export interface AdminTierStatus {
  ok: boolean
  error?: string
  /** Capability-probe outcome recorded at save time (ticket 10). */
  probe?: { status: 'verified' | 'mismatch' | 'unverifiable', detail?: string, probedAt: string }
}

/** One registered credential kind: its JSON Schema and optional field docs. */
export interface KindDescriptor {
  kind: string
  jsonSchema: Record<string, unknown>
  fieldsDoc?: string
  fileFields?: string[]
}

/** Body for POST /ops-access/admin/entry. */
export interface SubmitEntryBody {
  kind: string
  /** The entry's stable id (registry key, paths, mentions). */
  name: string
  tier: 'ro' | 'rw'
  fields: Record<string, unknown>
  contentFiles?: Record<string, string>
  /** Display label (editable, not an identity). */
  displayName?: string
  description?: string
  environment?: string
}

/** Generic API result shape from the admin routes. */
export interface ApiResult {
  ok: boolean
  error?: string
}

// ── Access panel wire shapes (mirror the gate's human-side routes) ──────────

/** One live grant row as reported by GET /ops-access/grants. */
export interface PanelGrant {
  kind: string
  name: string
  expiresAt: number
  reason: string
  approvedBy: string
  remainingMinutes: number
}

/** One parked request_access call awaiting a human decision. */
export interface PanelPendingRequest {
  id: string
  session: string
  /** The dispatching session, when the requester is a spawned sub-agent (血缘). */
  parentSession?: string
  kind: string
  name: string
  requestedTtlMinutes: number
  reason: string
  createdAt: number
  decidesAt: number
}

/** One operator lockdown row as reported by GET /ops-access/grants (ticket 12). */
export interface PanelDenied {
  kind: string
  name: string
  deniedAt: number
  reason: string
  deniedBy: string
}

/** One cross-session grant row as reported by GET /ops-access/grants/all. */
export interface OverviewGrant extends PanelGrant { session: string }
