/**
 * Client half for ops-access-ui:
 *
 * 1. Registers an `access` source on the `@` trigger. Candidates come from
 *    `GET /ops-access/list` (served preset-plane by the ops-access core
 *    package). When the ops preset is not mounted the route 404s and this
 *    source degrades to no candidates.
 *
 * 2. Registers a `settings.section` entry (id `ops-access-admin`, label
 *    "凭证管理") that renders a credential-management page in the dsh
 *    settings panel. The page lists all credential entries (ro+rw merged,
 *    with per-tier validation icons), supports adding entries via a
 *    JSON-Schema-driven dynamic form, and deleting entries with a confirm
 *    dialog. All data flows through the admin HTTP routes served by the
 *    ops-access core package; route 404 or network failure degrades
 *    gracefully (empty list or inline message, never a white screen).
 *
 * A pick inserts a ReferenceInsert whose ref is the ready-made
 * `@[kind/name](dsh-access:...)` mention from the route; the codec is the
 * identity — the full mention travels in the submitted text and the
 * preset-plane agent/pre-step listener (in @deepseek-ai/dsh-ops-access)
 * expands it.
 *
 * Bundled by esbuild into lib/client.js in the ModuleLoader lazy-CJS format.
 *
 * @module @deepseek-ai/dsh-ops-access-ui/client
 */

import { createElement as h, useState, useEffect, useCallback } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  InputTriggerCandidate,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-access-ui-client'
// Static inject on both services: the loader applies us only after they exist
// — a ctx.get at apply time can lose the race and silently skip registration.
const inject = ['inputTriggers', 'slots']

// ── @-mention wire shape (mirrors the route in ops-access core) ─────────────

interface AccessMentionCandidate {
  kind: string
  name: string
  description?: string
  environment?: string
  /** Tier readiness — entries with only an rw tier still appear (ro derivable). */
  ro: boolean
  rw: boolean
  mention: string
}

// ── Admin wire shapes (mirrors the admin routes in ops-access core) ─────────

/** One entry in the merged admin view: envelope + per-tier validation, never fields. */
interface AdminEntry {
  kind: string
  /** Stable id (registry key). */
  name: string
  /** envelope.name is the editable display label. */
  envelope: { name?: string, description?: string, environment?: string }
  tiers: { ro: AdminTierStatus, rw: AdminTierStatus }
}

/** Validation status of one entry in one tier. */
interface AdminTierStatus {
  ok: boolean
  error?: string
  /** Capability-probe outcome recorded at save time (ticket 10). */
  probe?: { status: 'verified' | 'mismatch' | 'unverifiable', detail?: string, probedAt: string }
}

/** One registered credential kind: its JSON Schema and optional field docs. */
interface KindDescriptor {
  kind: string
  jsonSchema: Record<string, unknown>
  fieldsDoc?: string
  fileFields?: string[]
}

/** Body for POST /ops-access/admin/entry. */
interface SubmitEntryBody {
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
interface ApiResult {
  ok: boolean
  error?: string
}

// ── Admin API functions ──────────────────────────────────────────────────────
// Pure fetch wrappers so the data-fetching logic is unit-testable without
// rendering the React component. Each degrades gracefully: a 404 (ops preset
// absent) or network failure returns an empty result, never throws.

/**
 * Shared fetch wrapper for list-shaped admin API calls. Degrades to
 * `degraded` (typically `[]`) on a 404 (ops preset absent) or network
 * failure — never throws.
 */
async function apiFetchList<T>(
  url: string,
  init: RequestInit,
  degraded: T,
): Promise<T> {
  try {
    const res = await fetch(url, init)
    if (!res.ok) return degraded
    return await res.json() as T
  } catch {
    return degraded
  }
}

/**
 * Shared fetch wrapper for ApiResult-shaped admin API calls (POST/DELETE).
 * Always returns an `ApiResult` — `{ ok: false, error }` on any failure,
 * never throws. The `errorPrefix` labels the failure source.
 */
async function apiFetchResult(
  url: string,
  init: RequestInit,
  errorPrefix: string,
): Promise<ApiResult> {
  try {
    const res = await fetch(url, init)
    if (!res.ok) return { ok: false, error: `${errorPrefix}: HTTP ${res.status}` }
    return await res.json() as ApiResult
  } catch (err) {
    return { ok: false, error: String((err as Error | null)?.message ?? err) }
  }
}

/** Fetch the merged admin entry list. Degrades to [] on any failure. */
function fetchAdminList(signal?: AbortSignal): Promise<AdminEntry[]> {
  return apiFetchList<AdminEntry[]>('/ops-access/admin/list', { signal }, [])
}

/** Fetch registered credential kinds. Degrades to [] on any failure. */
function fetchKinds(signal?: AbortSignal): Promise<KindDescriptor[]> {
  return apiFetchList<KindDescriptor[]>('/ops-access/admin/kinds', { signal }, [])
}

/** Submit a new/updated entry. Returns the API result; never throws. */
function submitEntry(body: SubmitEntryBody): Promise<ApiResult> {
  return apiFetchResult('/ops-access/admin/entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 'submitEntry')
}

/** Delete one entry from one tier. Returns the API result; never throws. */
function deleteEntry(kind: string, name: string, tier: 'ro' | 'rw'): Promise<ApiResult> {
  const params = new URLSearchParams({ kind, name, tier })
  return apiFetchResult(`/ops-access/admin/entry?${params}`, {
    method: 'DELETE',
  }, 'deleteEntry')
}
/** Read back one entry for editing. Returns null if not found. */
// Result: { fields, fileFields, displayName?, description?, environment? }
// `fields` holds only NON-file fields (connection params); file fields are
// write-only after save — `fileFields` carries their set status as booleans.
async function fetchEntry(kind, name, tier) {
  const params = new URLSearchParams({ kind, name, tier })
  try {
    const res = await fetch('/ops-access/admin/entry?' + params)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}



// ── Access panel API functions (mirror the gate's human-side routes) ─────────

/** One live grant row as reported by GET /ops-access/grants. */
interface PanelGrant {
  kind: string
  name: string
  expiresAt: number
  reason: string
  approvedBy: string
  remainingMinutes: number
}

/** One parked request_access call awaiting a human decision. */
interface PanelPendingRequest {
  id: string
  session: string
  kind: string
  name: string
  requestedTtlMinutes: number
  reason: string
  createdAt: number
  decidesAt: number
}

/** Fetch this session's live grants + the configured TTL options. Null on failure. */
async function fetchPanelGrants(sessionId: string, signal?: AbortSignal): Promise<{ grants: PanelGrant[], ttlOptions: number[] } | null> {
  try {
    const res = await fetch('/ops-access/grants?session=' + encodeURIComponent(sessionId), { signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Fetch this session's pending access requests. Null on failure. */
async function fetchPanelRequests(sessionId: string, signal?: AbortSignal): Promise<{ requests: PanelPendingRequest[] } | null> {
  try {
    const res = await fetch('/ops-access/access-requests?session=' + encodeURIComponent(sessionId), { signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Grant a profile to the session from the panel. Returns the API result; never throws. */
function postPanelGrant(sessionId: string, kind: string, name: string, ttlMinutes: number): Promise<ApiResult> {
  return apiFetchResult('/ops-access/grants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: sessionId, kind, name, ttlMinutes }),
  }, 'postPanelGrant')
}

/** Revoke one grant. Returns the API result; never throws. */
function postPanelRevoke(sessionId: string, kind: string, name: string): Promise<ApiResult> {
  return apiFetchResult('/ops-access/grants/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: sessionId, kind, name }),
  }, 'postPanelRevoke')
}

/** Revoke every grant of the session. Returns the API result; never throws. */
function postPanelRevokeAll(sessionId: string): Promise<ApiResult> {
  return apiFetchResult('/ops-access/grants/revoke-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: sessionId }),
  }, 'postPanelRevokeAll')
}

/** Extend one active grant by a TTL tier (renewed from now). Never throws. */
function postPanelExtend(sessionId: string, kind: string, name: string, ttlMinutes: number): Promise<ApiResult> {
  return apiFetchResult('/ops-access/grants/extend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: sessionId, kind, name, ttlMinutes }),
  }, 'postPanelExtend')
}

/** Decide a pending request (approve with a TTL option, or reject). Never throws. */
function postPanelDecide(id: string, approved: boolean, ttlMinutes?: number): Promise<ApiResult> {
  return apiFetchResult('/ops-access/access-requests/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(approved ? { id, approved, ttlMinutes } : { id, approved }),
  }, 'postPanelDecide')
}

// ── Pending-request badge (input dock) ─────────────────────────────────────

/** Structural slice of the runtime conversation snapshot the badge reads. */
interface SnapshotRunningCall { name: string }

/**
 * Count this session's in-flight request_access calls: each parked call is
 * one pending human decision. The runtime pairs tool/call with tool/result
 * into runningCalls, so a decided or timed-out request drops out on its
 * own — zero polling, straight off the session snapshot the dock owner
 * already passes.
 */
function pendingAccessCount(session: { runningCalls?: readonly SnapshotRunningCall[] } | null | undefined): number {
  if (session === null || session === undefined || !Array.isArray(session.runningCalls)) return 0
  return session.runningCalls.filter((c) => c.name === 'request_access').length
}

/** Dock badge props: the InputZone owner share plus the framework sessionId. */
interface AccessBadgeProps {
  sessionId?: string
  session?: { runningCalls?: readonly SnapshotRunningCall[] }
  /** Open the access panel imperatively (ops-panel seam, ADR-0004 §9). */
  openPanel: (sessionId: string) => boolean
}

/**
 * Red-dot alert in the input dock while request_access calls await a human
 * decision: renders nothing on an empty pending set (decided/timed-out
 * requests leave runningCalls, extinguishing the badge on their own);
 * clicking opens the access panel's approval deck.
 */
function AccessBadge(props: AccessBadgeProps): unknown {
  const count = pendingAccessCount(props.session)
  if (count === 0 || props.sessionId === undefined) return null
  const sid = props.sessionId
  return h('button', {
    className: 'ops-access-badge',
    title: '有待审批的提权申请 — 点击打开授权面板',
    onClick: () => props.openPanel(sid),
  },
    h('span', { className: 'ops-access-badge-dot' }),
    String(count) + ' 个提权申请待审批',
  )
}

// ── CSS (theme variables, same discipline as trace dock) ────────────────────

const CSS = `
.ops-access-admin-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 4px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1f2328);
}

.ops-access-admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ops-access-admin-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}

.ops-access-admin-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ops-access-admin-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  border-radius: 6px;
  background: var(--dsw-alias-bg-primary, #fff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

.ops-access-admin-btn:hover {
  background: var(--dsw-alias-bg-hover, #e9ecef);
}

.ops-access-admin-btn-primary {
  border-color: var(--dsw-alias-state-business-primary, #0969da);
  background: var(--dsw-alias-state-business-primary, #0969da);
  color: #fff;
}

.ops-access-admin-btn-primary:hover {
  opacity: 0.9;
  background: var(--dsw-alias-state-business-primary, #0969da);
}

.ops-access-admin-btn-danger {
  color: #d1242f;
}

.ops-access-admin-btn-danger:hover {
  background: rgba(209, 36, 47, 0.08);
}

.ops-access-admin-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ops-access-admin-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ops-access-admin-card {
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  border-radius: 8px;
  overflow: hidden;
}

.ops-access-admin-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--dsw-alias-bg-secondary, #f6f8fa);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}

.ops-access-admin-card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}

.ops-access-admin-card-count {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #848d97);
}

.ops-access-admin-card-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #f0f0f0);
}

.ops-access-admin-card-row:last-child {
  border-bottom: none;
}

.ops-access-admin-card-row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.ops-access-admin-card-row-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #1f2328);
  word-break: break-all;
}

.ops-access-admin-card-row-id {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 400;
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  color: var(--dsw-alias-label-tertiary, #848d97);
}

.ops-access-admin-card-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ops-access-admin-card-env {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #848d97);
}

.ops-access-admin-card-row-desc {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #656d76);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ops-access-admin-tier-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.ops-access-admin-tier-ok {
  color: var(--dsw-alias-state-success-primary, #1a7f37);
}

.ops-access-admin-tier-err {
  color: #d1242f;
}

.ops-access-admin-tier-na {
  color: var(--dsw-alias-label-tertiary, #848d97);
}

.ops-access-admin-row-actions {
  display: flex;
  gap: 4px;
}

.ops-access-admin-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #848d97);
}

.ops-access-admin-error {
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(209, 36, 47, 0.08);
  color: #d1242f;
  font-size: 12px;
}

.ops-access-admin-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ops-access-admin-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ops-access-admin-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #656d76);
}

.ops-access-admin-required {
  color: #d1242f;
  margin-left: 2px;
}

.ops-access-admin-type-hint {
  color: var(--dsw-alias-label-tertiary, #848d97);
  font-size: 11px;
  margin-left: 4px;
}

.ops-access-admin-input {
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  border-radius: 6px;
  background: var(--dsw-alias-bg-primary, #fff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 20px;
}

.ops-access-admin-input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, #0969da);
}

.ops-access-admin-textarea {
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  resize: vertical;
  min-height: 120px;
}

.ops-access-admin-radio-group {
  display: flex;
  align-items: center;
  gap: 16px;
}

.ops-access-admin-radio-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.ops-access-admin-confirm {
  padding: 12px 16px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  border-radius: 8px;
  background: var(--dsw-alias-bg-secondary, #f6f8fa);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ops-access-admin-tier-section {
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ops-access-admin-tier-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px dashed var(--dsw-alias-border-l1, #e5e7eb);
}

/* ── Access panel (授权面板) ── */
.ops-access-panel { display: flex; flex-direction: column; gap: 14px; }
.ops-access-panel-section { display: flex; flex-direction: column; gap: 6px; }
.ops-access-panel-heading { font-size: 12px; font-weight: 600; opacity: 0.65; }
.ops-access-panel-empty { font-size: 12px; opacity: 0.5; padding: 4px 0; }
.ops-access-panel-message {
  font-size: 12px; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  background: var(--dsw-specific-tip, #f6f8fa);
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
.ops-access-panel-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; border-radius: 8px; gap: 8px;
}
.ops-access-panel-row.clickable { cursor: pointer; }
.ops-access-panel-row.clickable:hover { background: var(--dsw-alias-bg-secondary, #f6f8fa); }
.ops-access-panel-row-title { font-weight: 500; display: flex; align-items: center; gap: 8px; }
.ops-access-panel-row-detail { font-size: 12px; opacity: 0.55; }
.ops-access-panel-request {
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 8px;
  padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-specific-tip, #f6f8fa);
}
.ops-access-panel-reason { font-size: 12px; opacity: 0.75; white-space: pre-wrap; }
.ops-access-panel-badge {
  font-size: 11px; font-weight: 400; padding: 1px 6px; border-radius: 4px;
  background: var(--dsw-alias-bg-secondary, #eaeef2);
}
.ops-access-panel-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 2px 10px 4px; }
.ops-access-panel-ttl-row { display: inline-flex; gap: 4px; }
.ops-access-panel-btn {
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 6px;
  background: transparent; color: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
}
.ops-access-panel-btn:hover { background: var(--dsw-alias-bg-secondary, #f6f8fa); }
.ops-access-panel-btn.primary { border-color: var(--dsw-alias-primary, #0969da); color: var(--dsw-alias-primary, #0969da); }
.ops-access-panel-btn.danger { border-color: var(--dsw-alias-danger, #cf222e); color: var(--dsw-alias-danger, #cf222e); }
.ops-access-panel-btn.ttl.selected { background: var(--dsw-alias-primary, #0969da); border-color: var(--dsw-alias-primary, #0969da); color: #fff; }
.ops-access-panel-confirm {
  display: flex; align-items: center; gap: 8px; font-size: 12px;
  padding: 6px 10px; margin: 2px 0; border-radius: 6px;
  border: 1px dashed var(--dsw-alias-danger, #cf222e);
}
.ops-access-panel .danger-zone .ops-access-panel-row-title { color: var(--dsw-alias-danger, #cf222e); }
.ops-access-panel-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; margin-right: 6px; vertical-align: 1px; }
.ops-access-panel-dot.rw { background: var(--dsw-alias-success, #1a7f37); box-shadow: 0 0 4px var(--dsw-alias-success, #1a7f37); }
.ops-access-panel-dot.deny { background: var(--dsw-alias-danger, #cf222e); }
.ops-access-badge {
  display: inline-flex; align-items: center; gap: 6px; width: fit-content;
  padding: 3px 10px; border-radius: 999px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  background: var(--dsw-alias-bg-primary, #ffffff);
  color: var(--dsw-alias-text-primary, #1f2328);
}
.ops-access-badge:hover { background: var(--dsw-alias-bg-secondary, #f6f8fa); }
.ops-access-admin-probe { font-size: 11px; padding: 0 6px; border-radius: 4px; margin-left: 6px; }
.ops-access-admin-probe.verified { background: var(--dsw-alias-success, #1a7f37); color: #fff; }
.ops-access-admin-probe.mismatch { background: var(--dsw-alias-danger, #cf222e); color: #fff; }
.ops-access-admin-probe.unverifiable { background: var(--dsw-alias-bg-secondary, #eaeef2); opacity: 0.8; }
.ops-access-badge-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-danger, #cf222e);
  box-shadow: 0 0 0 3px rgba(207, 34, 46, 0.18);
}
`.trim()

let cssInjected = false
function injectCSS(): void {
  if (cssInjected || typeof document === 'undefined') return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'ops-access-admin'
  tag.textContent = CSS
  document.head.appendChild(tag)
  cssInjected = true
}

// ── Inline SVG icons (14px, same discipline as trace dock glyphs) ───────────

function CheckIcon(): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M11.5 4.5L6 10L2.5 6.5', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

function CrossIcon(): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M4 4L10 10M10 4L4 10', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round',
  }))
}

function RefreshIcon(): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M11.5 2.5V5H9M2.5 7.5C2.5 4.74 4.74 2.5 7.5 2.5C9.1 2.5 10.5 3.2 11.5 4.2M2.5 7.5C2.5 10.26 4.74 12.5 7.5 12.5C9.1 12.5 10.5 11.8 11.5 10.8M2.5 7.5V5H5',
    stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

function PlusIcon(): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M7 2.5V11.5M2.5 7H11.5', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round',
  }))
}

function TrashIcon(): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M3 4H11M5.5 4V3C5.5 2.5 5.7 2 6.5 2H7.5C8.3 2 8.5 2.5 8.5 3V4M4 4L4.5 12H9.5L10 4',
    stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

function EditIcon(): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M9.5 2.5L11.5 4.5L5 11H3V9L9.5 2.5Z',
    stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

// ── JSON Schema field extraction ─────────────────────────────────────────────

interface SchemaField {
  name: string
  type: string
  required: boolean
}

/** Extract renderable fields from a JSON Schema's properties + required arrays. */
function extractSchemaFields(jsonSchema: Record<string, unknown>): SchemaField[] {
  const properties = jsonSchema.properties
  if (typeof properties !== 'object' || properties === null) return []
  const requiredArr = Array.isArray(jsonSchema.required) ? jsonSchema.required as string[] : []
  const requiredSet = new Set(requiredArr)
  return Object.entries(properties)
    .filter(([, v]) => typeof v === 'object' && v !== null)
    .map(([name, v]) => {
      const prop = v as Record<string, unknown>
      return {
        name,
        type: typeof prop.type === 'string' ? prop.type : 'string',
        required: requiredSet.has(name),
      }
    })
}

// ── Tier status badge ────────────────────────────────────────────────────────

function TierBadge({ status }: { status: AdminTierStatus }): any {
  if (status.ok) {
    const probe = status.probe
    const chip = probe === undefined ? null
      : h('span', {
        className: 'ops-access-admin-probe ' + probe.status,
        title: (probe.detail !== undefined ? probe.detail + ' · ' : '') + 'probed ' + probe.probedAt,
      }, probe.status === 'verified' ? '已核验' : probe.status === 'mismatch' ? '核验失败' : '无法核验')
    return h('span', { className: 'ops-access-admin-tier-cell ops-access-admin-tier-ok' },
      h(CheckIcon),
      chip,
    )
  }
  const title = status.error ?? 'not registered'
  return h('span', {
    className: 'ops-access-admin-tier-cell ops-access-admin-tier-err',
    title,
  }, h(CrossIcon))
}

// ── List view ───────────────────────────────────────────────────────────────

function AdminListView(props: {
  entries: AdminEntry[],
  loading: boolean,
  onRefresh: () => void,
  onAdd: () => void,
  onEdit: (entry: AdminEntry) => void,
  onDelete: (entry: AdminEntry) => void,
}): any {
  const { entries, loading, onRefresh, onAdd, onEdit, onDelete } = props
  // Group entries by kind, preserving the order kinds first appear
  const kindOrder: string[] = []
  const byKind: Record<string, AdminEntry[]> = {}
  for (const e of entries) {
    if (!(e.kind in byKind)) { kindOrder.push(e.kind); byKind[e.kind] = [] }
    byKind[e.kind].push(e)
  }
  return h('div', { className: 'ops-access-admin-root' },
    h('div', { className: 'ops-access-admin-header' },
      h('span', { className: 'ops-access-admin-title' }, '凭证管理'),
      h('div', { className: 'ops-access-admin-actions' },
        h('button', {
          type: 'button',
          className: 'ops-access-admin-btn',
          onClick: onRefresh,
          disabled: loading,
        }, h(RefreshIcon), loading ? '加载中…' : '刷新'),
        h('button', {
          type: 'button',
          className: 'ops-access-admin-btn ops-access-admin-btn-primary',
          onClick: onAdd,
        }, h(PlusIcon), '新增'),
      ),
    ),
    entries.length === 0
      ? h('div', { className: 'ops-access-admin-empty' },
          loading ? '加载中…' : '暂无凭证条目',
        )
      : h('div', { className: 'ops-access-admin-cards' },
          ...kindOrder.map((kind) =>
            h('div', { key: kind, className: 'ops-access-admin-card' },
              h('div', { className: 'ops-access-admin-card-header' },
                h('span', { className: 'ops-access-admin-card-title' }, kind),
                h('span', { className: 'ops-access-admin-card-count' },
                  String(byKind[kind].length) + ' 条'),
              ),
              ...byKind[kind].map((entry) =>
                h('div', { key: entry.name, className: 'ops-access-admin-card-row' },
                  h('div', { className: 'ops-access-admin-card-row-main' },
                    h('div', { className: 'ops-access-admin-card-row-name' },
                      entry.envelope.name ?? entry.name,
                      entry.envelope.name &&
                        h('span', { className: 'ops-access-admin-card-row-id' }, entry.name)),
                    h('div', { className: 'ops-access-admin-card-row-meta' },
                      entry.environment && h('span', { className: 'ops-access-admin-card-env' }, entry.environment),
                      h(TierBadge, { status: entry.tiers.ro }),
                      h(TierBadge, { status: entry.tiers.rw }),
                    ),
                    entry.envelope.description &&
                      h('div', { className: 'ops-access-admin-card-row-desc' },
                        entry.envelope.description),
                  ),
                  h('div', { className: 'ops-access-admin-row-actions' },
                    h('button', {
                      type: 'button',
                      className: 'ops-access-admin-btn',
                      title: '编辑',
                      onClick: () => onEdit(entry),
                    }, h(EditIcon)),
                    h('button', {
                      type: 'button',
                      className: 'ops-access-admin-btn ops-access-admin-btn-danger',
                      title: '删除',
                      onClick: () => onDelete(entry),
                    }, h(TrashIcon)),
                  ),
                ),
              ),
            ),
          ),
        ),
  )
}

// ── Form view ───────────────────────────────────────────────────────────────

function AdminFormView(props: {
  error: string | null,
  editEntry?: { kind: string, name: string },
  onSubmit: (body: SubmitEntryBody) => Promise<ApiResult> | void,
  onSubmitDone: () => void,
  onCancel: () => void,
}): any {
  const { error, editEntry, onSubmit, onSubmitDone, onCancel } = props
  const isEditing = !!editEntry
  const [kinds, setKinds] = useState<KindDescriptor[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedKind, setSelectedKind] = useState(editEntry?.kind ?? '')
  const [profileName, setProfileName] = useState(editEntry?.name ?? '')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [environment, setEnvironment] = useState('')
  // Per-tier field values and enable flags. A tier with any filled field is
  // written on submit; both tiers can be created/edited in one pass.
  const [roFields, setRoFields] = useState<Record<string, string>>({})
  const [rwFields, setRwFields] = useState<Record<string, string>>({})
  // Set status of file fields per tier (edit mode) — content never comes
  // back from the server, so textareas stay empty and show a placeholder.
  const [roFileSet, setRoFileSet] = useState<Record<string, boolean>>({})
  const [rwFileSet, setRwFileSet] = useState<Record<string, boolean>>({})
  const [roEnabled, setRoEnabled] = useState(!isEditing)
  const [rwEnabled, setRwEnabled] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const kindDescriptor = kinds.find((k) => k.kind === selectedKind)
  const schemaFields = kindDescriptor ? extractSchemaFields(kindDescriptor.jsonSchema) : []

  // Fetch kinds on mount, and in edit mode also fetch the entry from both tiers.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchKinds().then(async (result) => {
      if (cancelled) return
      setKinds(result)
      if (editEntry) {
        const [roEntry, rwEntry] = await Promise.all([
          fetchEntry(editEntry.kind, editEntry.name, 'ro'),
          fetchEntry(editEntry.kind, editEntry.name, 'rw'),
        ])
        if (cancelled) return
        const toStrings = (src: { fields?: Record<string, unknown> } | null): Record<string, string> => {
          const out: Record<string, string> = {}
          if (src?.fields && typeof src.fields === 'object') {
            for (const [k, v] of Object.entries(src.fields)) out[k] = v == null ? '' : String(v)
          }
          return out
        }
        if (roEntry) { setRoFields(toStrings(roEntry)); setRoFileSet(roEntry.fileFields ?? {}); setRoEnabled(true) }
        if (rwEntry) { setRwFields(toStrings(rwEntry)); setRwFileSet(rwEntry.fileFields ?? {}); setRwEnabled(true) }
        const env = roEntry ?? rwEntry
        if (env?.displayName) setDisplayName(env.displayName)
        if (env?.description) setDescription(env.description)
        if (env?.environment) setEnvironment(env.environment)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const handleTierFieldChange = useCallback((tier: 'ro' | 'rw', name: string, value: string) => {
    if (tier === 'ro') setRoFields((prev) => ({ ...prev, [name]: value }))
    else setRwFields((prev) => ({ ...prev, [name]: value }))
  }, [])

  const handleSubmit = useCallback(async () => {
    setSubmitError(null)
    if (!selectedKind) { setSubmitError('请选择凭证类型'); return }
    if (!profileName.trim()) { setSubmitError('请输入 ID'); return }
    const activeTiers = (['ro', 'rw'] as const).filter((t) => t === 'ro' ? roEnabled : rwEnabled)
    if (activeTiers.length === 0) { setSubmitError('请至少启用一个档位 (ro / rw)'); return }
    setSubmitting(true)
    const fileFieldSet = new Set(kindDescriptor?.fileFields ?? [])
    // Always send all three envelope fields: the core treats an omitted
    // field as "preserve" and an empty string as "clear", so clearing a
    // display name or description must send the empty value explicitly.
    const envelope: Record<string, string> = {
      displayName: displayName.trim(),
      description: description.trim(),
      environment: environment.trim(),
    }
    try {
      for (const t of activeTiers) {
        const tierValues = t === 'ro' ? roFields : rwFields
        // Create mode: skip a tier with no filled field at all (user enabled
        // but left blank). Edit mode always submits enabled tiers — the
        // envelope rides along and the server carries over untouched file
        // fields (they are write-only after save, so they cannot be resent).
        if (!isEditing && Object.values(tierValues).every((v) => !String(v ?? '').trim())) continue
        const baseFields: Record<string, unknown> = {}
        const contentFiles: Record<string, string> = {}
        for (const [k, v] of Object.entries(tierValues)) {
          // Empty content = untouched → omit; the server preserves the
          // stored credential. Only non-empty content overwrites.
          if (fileFieldSet.has(k)) {
            const content = String(v ?? '')
            if (content.trim() !== '') contentFiles[k] = content
          } else baseFields[k] = v
        }
        // Convert number fields back to numbers
        for (const f of schemaFields) {
          if (f.type === 'number' && baseFields[f.name] != null && baseFields[f.name] !== '') {
            baseFields[f.name] = Number(baseFields[f.name])
          }
        }
        const result = await onSubmit({
          kind: selectedKind,
          name: profileName.trim(),
          tier: t,
          fields: baseFields,
          ...Object.keys(contentFiles).length > 0 ? { contentFiles } : {},
          ...envelope,
        }) as ApiResult | undefined
        if (result && !result.ok) {
          setSubmitting(false)
          setSubmitError(t + ': ' + (result.error ?? '提交失败'))
          return
        }
      }
    } catch {
      setSubmitting(false)
      setSubmitError('提交失败')
      return
    }
    // All submits succeeded — tell the parent to switch to list view.
    onSubmitDone()
  }, [selectedKind, profileName, displayName, roEnabled, rwEnabled, roFields, rwFields, description, environment, onSubmit, onSubmitDone, schemaFields, kindDescriptor])

  if (loading) {
    return h('div', { className: 'ops-access-admin-root' },
      h('div', { className: 'ops-access-admin-empty' }, isEditing ? '加载凭证…' : '加载凭证类型…'),
    )
  }

  if (kinds.length === 0) {
    return h('div', { className: 'ops-access-admin-root' },
      h('div', { className: 'ops-access-admin-empty' },
        '没有已注册的凭证类型。请先安装凭证 provider 插件。'),
      h('button', {
        type: 'button',
        className: 'ops-access-admin-btn',
        onClick: onCancel,
      }, '返回'),
    )
  }

  const displayError = submitError ?? error

  // Render one tier's field set (shared shape for ro and rw sections).
  const renderTierFields = (tier: 'ro' | 'rw', values: Record<string, string>, fileSet: Record<string, boolean>) =>
    schemaFields.map((f) => {
      const isContent = kindDescriptor?.fileFields?.includes(f.name)
      return h('div', { key: tier + ':' + f.name, className: 'ops-access-admin-field' },
        h('label', { className: 'ops-access-admin-label' }, f.name,
          f.required && h('span', { className: 'ops-access-admin-required' }, '*'),
          h('span', { className: 'ops-access-admin-type-hint' },
            isContent ? '内容' : f.type)),
        isContent
          ? h('textarea', {
              className: 'ops-access-admin-input ops-access-admin-textarea',
              rows: 8,
              // Saved credential content is never read back: the textarea
              // stays empty and says so; pasting new content overwrites.
              placeholder: isEditing
                ? (fileSet[f.name] ? '已保存 · 内容不可回读 — 粘贴新内容以覆盖' : '未设置 — 粘贴内容以添加')
                : '粘贴完整内容…',
              value: values[f.name] ?? '',
              onChange: (e: any) => handleTierFieldChange(tier, f.name, e.target.value),
            })
          : h('input', {
              className: 'ops-access-admin-input',
              type: f.type === 'number' ? 'number' : 'text',
              value: values[f.name] ?? '',
              onChange: (e: any) => handleTierFieldChange(tier, f.name, e.target.value),
            }),
      )
    })

  return h('div', { className: 'ops-access-admin-root' },
    h('div', { className: 'ops-access-admin-header' },
      h('span', { className: 'ops-access-admin-title' }, isEditing ? '编辑凭证' : '新增凭证'),
      h('button', {
        type: 'button',
        className: 'ops-access-admin-btn',
        onClick: onCancel,
      }, '返回'),
    ),
    displayError && h('div', { className: 'ops-access-admin-error' }, displayError),
    h('div', { className: 'ops-access-admin-form' },
      // ── Common info (shared by both tiers) ──
      h('div', { className: 'ops-access-admin-field' },
        h('label', { className: 'ops-access-admin-label' }, '凭证类型',
          h('span', { className: 'ops-access-admin-required' }, '*')),
        h('select', {
          className: 'ops-access-admin-input',
          value: selectedKind,
          disabled: isEditing,
          onChange: (e: any) => {
            setSelectedKind(e.target.value)
            setRoFields({})
            setRwFields({})
          },
        },
          h('option', { value: '' }, '— 选择 —'),
          ...kinds.map((k) =>
            h('option', { key: k.kind, value: k.kind }, k.kind),
          ),
        ),
      ),
      h('div', { className: 'ops-access-admin-field' },
        h('label', { className: 'ops-access-admin-label' }, 'ID',
          h('span', { className: 'ops-access-admin-required' }, '*'),
          h('span', { className: 'ops-access-admin-type-hint' }, '字母/数字开头，可含 . _ - @；创建后不可改')),
        h('input', {
          className: 'ops-access-admin-input',
          type: 'text',
          value: profileName,
          disabled: isEditing,
          onChange: (e: any) => setProfileName(e.target.value),
        }),
      ),
      h('div', { className: 'ops-access-admin-field' },
        h('label', { className: 'ops-access-admin-label' }, '名称 (可选)',
          h('span', { className: 'ops-access-admin-type-hint' }, '显示用，随时可改')),
        h('input', {
          className: 'ops-access-admin-input',
          type: 'text',
          value: displayName,
          onChange: (e: any) => setDisplayName(e.target.value),
        }),
      ),
      h('div', { className: 'ops-access-admin-field' },
        h('label', { className: 'ops-access-admin-label' }, '描述 (可选)'),
        h('input', {
          className: 'ops-access-admin-input',
          type: 'text',
          value: description,
          onChange: (e: any) => setDescription(e.target.value),
        }),
      ),
      h('div', { className: 'ops-access-admin-field' },
        h('label', { className: 'ops-access-admin-label' }, '环境 (可选)'),
        h('input', {
          className: 'ops-access-admin-input',
          type: 'text',
          value: environment,
          onChange: (e: any) => setEnvironment(e.target.value),
        }),
      ),
      // ── ro tier ──
      schemaFields.length > 0 && h('div', { className: 'ops-access-admin-tier-section' },
        h('label', { className: 'ops-access-admin-radio-label' },
          h('input', {
            type: 'checkbox',
            checked: roEnabled,
            onChange: (e: any) => setRoEnabled(e.target.checked),
          }), 'ro (只读)'),
        roEnabled && h('div', { className: 'ops-access-admin-tier-fields' },
          ...renderTierFields('ro', roFields, roFileSet)),
      ),
      // ── rw tier ──
      schemaFields.length > 0 && h('div', { className: 'ops-access-admin-tier-section' },
        h('label', { className: 'ops-access-admin-radio-label' },
          h('input', {
            type: 'checkbox',
            checked: rwEnabled,
            onChange: (e: any) => setRwEnabled(e.target.checked),
          }), 'rw (读写)'),
        rwEnabled && h('div', { className: 'ops-access-admin-tier-fields' },
          ...renderTierFields('rw', rwFields, rwFileSet)),
      ),
      // Submit
      h('div', { className: 'ops-access-admin-actions' },
        h('button', {
          type: 'button',
          className: 'ops-access-admin-btn ops-access-admin-btn-primary',
          onClick: handleSubmit,
          disabled: submitting,
        }, submitting ? '提交中…' : '提交'),
        h('button', {
          type: 'button',
          className: 'ops-access-admin-btn',
          onClick: onCancel,
        }, '取消'),
      ),
    ),
  )
}

// ── Settings section component ───────────────────────────────────────────────

function AdminSection(_props: { close?: () => void }): any {
  const [view, setView] = useState<'list' | 'form'>('list')
  const [entries, setEntries] = useState<AdminEntry[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [editEntry, setEditEntry] = useState<{ kind: string, name: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  const refreshList = useCallback(async () => {
    setListLoading(true)
    const result = await fetchAdminList()
    setEntries(result)
    setListLoading(false)
  }, [])

  useEffect(() => {
    refreshList()
  }, [refreshList])

  const handleAdd = useCallback(() => {
    setEditEntry(null)
    setView('form')
    setFormError(null)
  }, [])

  const handleEdit = useCallback((entry: AdminEntry) => {
    setEditEntry({ kind: entry.kind, name: entry.name })
    setView('form')
    setFormError(null)
  }, [])

  const handleSubmit = useCallback(async (body: SubmitEntryBody): Promise<ApiResult> => {
    return await submitEntry(body)
  }, [])

  const handleSubmitDone = useCallback(() => {
    setView('list')
    refreshList()
  }, [refreshList])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    // Delete from both ro and rw tiers — the admin list is a merged view,
    // so a full removal must clear both registries. Each tier's delete is
    // independent; a "not found" on one tier is expected and ignored.
    await Promise.all([
      deleteEntry(deleteTarget.kind, deleteTarget.name, 'ro'),
      deleteEntry(deleteTarget.kind, deleteTarget.name, 'rw'),
    ])
    setDeleting(false)
    setDeleteTarget(null)
    refreshList()
  }, [deleteTarget, refreshList])

  // Delete confirmation overlay
  if (deleteTarget) {
    return h('div', { className: 'ops-access-admin-root' },
      h('div', { className: 'ops-access-admin-confirm' },
        h('div', null, `确认删除 ${deleteTarget.kind}/${deleteTarget.name}？`),
        h('div', { className: 'ops-access-admin-actions' },
          h('button', {
            type: 'button',
            className: 'ops-access-admin-btn ops-access-admin-btn-danger',
            onClick: handleDeleteConfirm,
            disabled: deleting,
          }, deleting ? '删除中…' : '确认删除'),
          h('button', {
            type: 'button',
            className: 'ops-access-admin-btn',
            onClick: () => setDeleteTarget(null),
            disabled: deleting,
          }, '取消'),
        ),
      ),
    )
  }

  if (view === 'form') {
    return h(AdminFormView, {
      error: formError,
      editEntry: editEntry ?? undefined,
      onSubmit: handleSubmit,
      onSubmitDone: handleSubmitDone,
      onCancel: () => setView('list'),
    })
  }

  return h(AdminListView, {
    entries,
    loading: listLoading,
    onRefresh: refreshList,
    onAdd: handleAdd,
    onEdit: handleEdit,
    onDelete: (entry: AdminEntry) => setDeleteTarget(entry),
  })
}

// ── Access panel (授权面板, ADR-0004) ────────────────────────────────────────
// The content component registered into the ops-panel shell for /access.
// Three zones: pending requests (approve with an adjustable TTL / reject),
// this session's live grants (revoke one / revoke all), and the grant flow
// (pick a profile → pick a TTL → confirm). Grants and requests poll every
// 3 s while the panel is open; the component unmounts when it closes.

/** The panel content props (structural — the ops-panel shell supplies them). */
interface AccessPanelProps {
  sessionId: string
  close: () => void
}

/** The live grant covering one candidate profile, if this session holds one. */
function liveGrantFor(grants: PanelGrant[], kind: string, name: string): PanelGrant | undefined {
  return grants.find((g) => g.kind === kind && g.name === name)
}

/** Default approval TTL: the largest option not exceeding the request, else the smallest. */
function defaultTtlChoice(options: number[], requested: number): number {
  const sorted = [...options].sort((a, b) => a - b)
  const within = sorted.filter((o) => o <= requested)
  return within.length > 0 ? within[within.length - 1] : sorted[0]
}

function AccessPanel({ sessionId }: AccessPanelProps): any {
  const [grants, setGrants] = useState<PanelGrant[]>([])
  const [ttlOptions, setTtlOptions] = useState<number[]>([5, 10, 30])
  const [requests, setRequests] = useState<PanelPendingRequest[]>([])
  const [candidates, setCandidates] = useState<AccessMentionCandidate[]>([])
  const [grantTarget, setGrantTarget] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [ttlChoice, setTtlChoice] = useState<Record<string, number>>({})
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const g = await fetchPanelGrants(sessionId)
    if (g !== null) {
      setGrants(g.grants)
      if (Array.isArray(g.ttlOptions) && g.ttlOptions.length > 0) setTtlOptions(g.ttlOptions)
    }
    const r = await fetchPanelRequests(sessionId)
    if (r !== null) setRequests(r.requests)
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    fetch('/ops-access/list?query=')
      .then(async (res) => { if (res.ok && !cancelled) setCandidates(await res.json()) })
      .catch(() => { /* ops preset absent → no candidates */ })
    return () => { cancelled = true }
  }, [])

  /** Run one mutating action, show its outcome, and refresh. */
  async function run(action: () => Promise<ApiResult>, okText: string): Promise<void> {
    const res = await action()
    setMessage(res.ok ? okText : (res.error ?? '操作失败'))
    setConfirmKey(null)
    setGrantTarget(null)
    await refresh()
  }

  /** A two-click confirm strip shared by grant/revoke/revoke-all. */
  function confirmStrip(key: string, text: string, onConfirm: () => void): any {
    if (confirmKey !== key) return null
    return h('div', { className: 'ops-access-panel-confirm' },
      h('span', null, text),
      h('button', { className: 'ops-access-panel-btn danger', onClick: onConfirm }, '确认'),
      h('button', { className: 'ops-access-panel-btn', onClick: () => setConfirmKey(null) }, '取消'),
    )
  }

  /** A row of TTL option buttons with the selected one highlighted. */
  function ttlRow(selected: number, onPick: (ttl: number) => void): any {
    return h('span', { className: 'ops-access-panel-ttl-row' },
      ttlOptions.map((ttl) =>
        h('button', {
          key: ttl,
          className: 'ops-access-panel-btn ttl' + (ttl === selected ? ' selected' : ''),
          onClick: () => onPick(ttl),
        }, ttl + ' 分钟'),
      ),
    )
  }

  return h('div', { className: 'ops-access-panel' },
    message !== null && h('div', { className: 'ops-access-panel-message', onClick: () => setMessage(null) }, message),

    // ── Pending requests (approval mode) ──
    requests.length > 0 && h('div', { className: 'ops-access-panel-section' },
      h('div', { className: 'ops-access-panel-heading' }, '待审批的申请'),
      requests.map((req) => {
        const chosen = ttlChoice[req.id] ?? defaultTtlChoice(ttlOptions, req.requestedTtlMinutes)
        return h('div', { key: req.id, className: 'ops-access-panel-request' },
          h('div', { className: 'ops-access-panel-row-title' }, req.kind + '/' + req.name,
            h('span', { className: 'ops-access-panel-badge' }, '申请 ' + req.requestedTtlMinutes + ' 分钟')),
          h('div', { className: 'ops-access-panel-reason' }, req.reason),
          h('div', { className: 'ops-access-panel-actions' },
            ttlRow(chosen, (ttl) => setTtlChoice({ ...ttlChoice, [req.id]: ttl })),
            h('button', {
              className: 'ops-access-panel-btn primary',
              onClick: () => void run(() => postPanelDecide(req.id, true, chosen), '已批准 ' + req.kind + '/' + req.name + '（' + chosen + ' 分钟）'),
            }, '批准'),
            h('button', {
              className: 'ops-access-panel-btn',
              onClick: () => void run(() => postPanelDecide(req.id, false), '已拒绝 ' + req.kind + '/' + req.name),
            }, '拒绝'),
          ),
        )
      }),
    ),

    // ── Live grants (revoke) ──
    h('div', { className: 'ops-access-panel-section' },
      h('div', { className: 'ops-access-panel-heading' }, '本会话活跃授权'),
      grants.length === 0 && h('div', { className: 'ops-access-panel-empty' }, '无活跃授权'),
      grants.map((g) => {
        const key = g.kind + '/' + g.name
        return h('div', { key, className: 'ops-access-panel-grant' },
          h('div', {
            className: 'ops-access-panel-row clickable',
            onClick: () => setConfirmKey(confirmKey === 'row:' + key ? null : 'row:' + key),
          },
            h('span', { className: 'ops-access-panel-row-title' }, key),
            h('span', { className: 'ops-access-panel-row-detail' }, '剩 ' + g.remainingMinutes + ' 分钟 · ' + g.approvedBy),
          ),
          // The row expands into extend (per-TTL confirm, same two-click
          // discipline as the grant flow) and revoke. Renewal is from NOW —
          // repeated extends never accumulate past one TTL tier.
          confirmKey === 'row:' + key && h('div', { className: 'ops-access-panel-actions' },
            ttlRow(0, (ttl) => setConfirmKey('extend:' + key + ':' + ttl)),
            h('button', {
              className: 'ops-access-panel-btn',
              onClick: () => setConfirmKey('revoke:' + key),
            }, '收回…'),
          ),
          ttlOptions.map((ttl) =>
            confirmStrip('extend:' + key + ':' + ttl, '延长 ' + key + ' · 从现在起 ' + ttl + ' 分钟？', () =>
              void run(() => postPanelExtend(sessionId, g.kind, g.name, ttl), '已延长 ' + key + '（' + ttl + ' 分钟）'))),
          confirmStrip('revoke:' + key, '收回 ' + key + ' 的提权权限？', () =>
            void run(() => postPanelRevoke(sessionId, g.kind, g.name), '已收回 ' + key)),
        )
      }),
      grants.length > 1 && h('div', null,
        h('div', {
          className: 'ops-access-panel-row clickable danger-zone',
          onClick: () => setConfirmKey(confirmKey === 'revoke-all' ? null : 'revoke-all'),
        }, h('span', { className: 'ops-access-panel-row-title' }, '收回本会话全部授权')),
        confirmStrip('revoke-all', '收回全部 ' + grants.length + ' 项授权？', () =>
          void run(() => postPanelRevokeAll(sessionId), '已收回全部授权')),
      ),
    ),

    // ── Grant flow (pick profile → TTL → confirm) ──
    h('div', { className: 'ops-access-panel-section' },
      h('div', { className: 'ops-access-panel-heading' }, '授予提权访问'),
      candidates.length === 0 && h('div', { className: 'ops-access-panel-empty' }, '无可授权档案'),
      candidates.map((c) => {
        const key = c.kind + '/' + c.name
        const open = grantTarget === key
        const live = liveGrantFor(grants, c.kind, c.name)
        return h('div', { key, className: 'ops-access-panel-candidate' },
          h('div', {
            className: 'ops-access-panel-row clickable',
            onClick: () => { setGrantTarget(open ? null : key); setConfirmKey(null) },
          },
            h('span', { className: 'ops-access-panel-row-title' }, key),
            h('span', { className: 'ops-access-panel-row-detail' },
              // Access-state marker on the right: lit green = this session
              // holds an rw grant for the profile right now; no dot = plain
              // ro. (A red 'deny' state is reserved for the future lockdown.)
              live !== undefined &&
                h('span', {
                  className: 'ops-access-panel-dot rw',
                  title: '本会话已授权 rw · 剩 ' + live.remainingMinutes + ' 分钟',
                }),
              live !== undefined ? '已授权 · 剩 ' + live.remainingMinutes + ' 分钟'
                : (c.rw ? 'rw 就绪' : (c.ro ? '限时使用' : '未配置')),
              c.environment ? ' · ' + c.environment : ''),
          ),
          open && h('div', { className: 'ops-access-panel-actions' },
            ttlRow(0, (ttl) => setConfirmKey('grant:' + key + ':' + ttl)),
          ),
          open && ttlOptions.map((ttl) =>
            confirmStrip('grant:' + key + ':' + ttl, '授予 ' + key + ' · ' + ttl + ' 分钟？', () =>
              void run(() => postPanelGrant(sessionId, c.kind, c.name, ttl), '已授予 ' + key + '（' + ttl + ' 分钟）'))),
        )
      }),
    ),
  )
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

function apply(ctx: Context): void {
  // ── @-mention source (existing) ───────────────────────────────────────────
  const inputTriggers = ctx.get('inputTriggers') as
    | { registerSource(src: InputTriggerSource): () => void }
    | undefined
  if (inputTriggers !== undefined) {
    const source: InputTriggerSource = {
      trigger: '@',
      name: 'access',
      order: 2,
      async candidates(_session, { query, signal }) {
        let list: AccessMentionCandidate[]
        try {
          const res = await fetch(`/ops-access/list?query=${encodeURIComponent(query)}`, { signal })
          if (!res.ok) return []
          list = await res.json() as AccessMentionCandidate[]
        } catch {
          return []
        }
        return list.map((c): InputTriggerCandidate => ({
          name: `${c.kind}/${c.name}`,
          // Badge rw-only entries: the agent cannot read them yet, but the
          // rw→ro derivation flow starts from picking exactly these.
          description: c.ro ? c.description : [c.description, 'ro 未注册（可由 rw 派生）'].filter(Boolean).join(' — '),
          hint: c.environment,
          value: c.mention,
        }))
      },
      onPick({ candidate }) {
        const mention = candidate.value
        if (mention === undefined) return undefined
        return {
          insert: {
            source: 'access',
            ref: mention,
            label: candidate.name,
            clipboardText: `@${candidate.name}`,
          },
        }
      },
      codec: {
        clipboardText: (ref) => ref,
        serialize: (ref) => Promise.resolve(ref),
      },
    }
    ctx.effect(() => inputTriggers!.registerSource(source))
  }

  // ── Settings section registration ────────────────────────────────────────
  injectCSS()
  const slots = ctx.get('slots') as
    | { inject(slot: string, factory: () => unknown): () => void
        register(opts: Record<string, unknown>, component: unknown): () => void }
    | undefined
  if (slots !== undefined) {
    ctx.effect(() => slots.inject('settings.section', () =>
      slots.register(
        { name: 'settings.section', id: 'ops-access-admin', order: 20, label: '凭证管理' },
        AdminSection,
      ),
    ))
  }

  // ── Access panel (ops-panel seam) ──────────────────────────────────────────
  // Deferred inject: registers only when ops-panel is composed; without it the
  // mention source and admin section are unaffected. The /access command
  // itself is registered preset-plane by the gate — the panel opens only in
  // sessions whose preset mounts the gate.
  ;(ctx as unknown as { inject(deps: string[], cb: (c: unknown) => void): void }).inject(['opsPanels'], (pctx) => {
    const opsPanels = (pctx as { opsPanels?: {
      registerPanel(def: Record<string, unknown>): () => void
      open(sessionId: string, command: string): boolean
      close(sessionId: string): void
    } }).opsPanels
    if (opsPanels === undefined) return
    const effect = (pctx as { effect(fn: () => () => void): void }).effect.bind(pctx)
    effect(() =>
      opsPanels.registerPanel({
        command: 'access',
        title: '访问授权',
        component: AccessPanel,
      }),
    )
    // Pending-request badge in the input dock (ticket 03): lit while a
    // request_access call parks — derived from the session snapshot, zero
    // polling — click opens the approval deck through the seam's open().
    if (slots !== undefined) {
      effect(() =>
        slots.inject('conversation.input.dock', () =>
          slots.register(
            { name: 'conversation.input.dock', id: 'ops-access-badge', order: 30 },
            (props: { sessionId?: string, session?: { runningCalls?: readonly SnapshotRunningCall[] } }) =>
              AccessBadge({
                sessionId: props.sessionId,
                session: props.session,
                openPanel: (sid) => opsPanels.open(sid, 'access'),
              }),
          ),
        ),
      )
    }
  })
}

export { apply, inject, name }

// ── Internal exports (test-only) ────────────────────────────────────────────
// The plugin contract is { apply, inject, name } only. The symbols below are
// exported solely so the vitest spec can exercise the API functions and types
// directly without rendering React. They are NOT part of the public API and
// are not consumed by the esbuild bundle (which only uses the trio above).
// Using a separate named export group makes the boundary explicit.
/** @internal */
export {
  apiFetchList, apiFetchResult, fetchAdminList, fetchKinds, submitEntry, deleteEntry, AdminSection,
  fetchPanelGrants, fetchPanelRequests, postPanelGrant, postPanelExtend, postPanelRevoke, postPanelRevokeAll, postPanelDecide,
  AccessPanel, AccessBadge, pendingAccessCount, defaultTtlChoice, liveGrantFor,
}
/** @internal */
export type { AdminEntry, AdminTierStatus, KindDescriptor, SubmitEntryBody, ApiResult, PanelGrant, PanelPendingRequest }
