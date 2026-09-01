/**
 * Ops access gate — per-session credential brokering with human approval.
 *
 * This plugin owns the **authorization ledger**: an in-process map keyed by
 * session id (exec.agent.id). It registers a **pure-decision broker** into
 * the ops-access seam via registerAccessBroker; that broker answers 'rw'
 * when the calling session holds an unexpired grant for the profile, 'ro'
 * otherwise, and { deny } for approval-required kinds (ssh) without a grant.
 * Calls without an agent (system-internal) are ruled here too: tiered kinds
 * fail closed to ro, approval-required kinds deny outright. The gate never
 * sees credential fields — kind, profile name, and session id are its world.
 *
 * Human interaction runs through the **access panel** (ADR-0004), not dsh's
 * native approval channel: the native outcome vocabulary (allowed-once /
 * rejected / cancelled / unavailable) cannot carry a human-adjusted TTL, and
 * answerer ordering is not a priority mechanism. Two flows share one queue:
 *
 * - **Request flow**: the model calls request_access, the gate parks the tool
 *   promise in the **pending-request queue**, the panel's decide route
 *   settles it (the human may adjust the TTL to any configured option), and
 *   the tool result reports the TTL actually granted.
 * - **Panel flow**: the human opens the panel with /access and grants or
 *   revokes directly through the routes below. Panel grants are identical in
 *   shape and lifetime to request grants — only the origin differs.
 *
 * Grants carry a TTL — expiry is the only reliable fallback boundary (a web
 * session has no dependable end event). Panel actions notify the agent by
 * queueing a model-visible message drained at the next agent/pre-step (the
 * command surface never enters model history). Every request, decision,
 * grant, expiry, revoke, elevated issue, and ledger reset lands in a JSONL
 * audit file. Headless deployments (no webServer) fail request_access fast
 * with out-of-band guidance.
 *
 * @module @deepseek-ai/dsh-ops-access-gate
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AccessAgent, AccessBroker } from '@deepseek-ai/dsh-ops-access'
import { expandHome, registerAccessBroker } from '@deepseek-ai/dsh-ops-access'
import { registerPanelCommand } from '@deepseek-ai/dsh-ops-panel'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-gate'

export const inject = ['tools']

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

export const Config: z<Config> = z.object({
  approvalRequiredKinds: z.array(z.string()).default(['ssh']),
  defaultTtlMinutes: z.number().default(30),
  maxTtlMinutes: z.number().default(480),
  auditFile: z.string().default('~/.dsh-ops/audit.log'),
  grantTtlOptions: z.array(z.number()).default([5, 10, 30]),
  pendingRequestTimeoutMinutes: z.number().default(5),
  deniedFile: z.string().default('~/.dsh-ops/denied.json'),
})

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

interface PendingEntry {
  readonly req: PendingRequest
  readonly settle: (decision: RequestDecision) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * The pending-request queue: an in-process map of parked tool promises.
 * Each entry carries an unref'd timer that settles it as a timeout — an
 * unanswered request never hangs the agent forever. The queue dies with the
 * plugin fiber (cancelAll on dispose), same lifetime as the ledger.
 */
function makePendingQueue(
  now: () => number,
  onSettle: (req: PendingRequest, decision: RequestDecision) => void,
) {
  const entries = new Map<string, PendingEntry>()
  let counter = 0

  function finish(id: string, decision: RequestDecision): PendingRequest | undefined {
    const entry = entries.get(id)
    if (!entry) return undefined
    entries.delete(id)
    clearTimeout(entry.timer)
    onSettle(entry.req, decision)
    entry.settle(decision)
    return entry.req
  }

  return {
    /** Park one request; the returned promise settles exactly once. */
    add(input: Omit<PendingRequest, 'id' | 'createdAt' | 'decidesAt'>, timeoutMinutes: number) {
      const createdAt = now()
      const req: PendingRequest = {
        ...input,
        id: 'gr-' + createdAt.toString(36) + '-' + (++counter),
        createdAt,
        decidesAt: createdAt + timeoutMinutes * 60000,
      }
      let settle!: (decision: RequestDecision) => void
      const decision = new Promise<RequestDecision>((resolve) => { settle = resolve })
      const timer = setTimeout(() => { finish(req.id, { approved: false, outcome: 'timeout' }) }, timeoutMinutes * 60000)
      // Never hold the process (or a test runner) open for a parked request.
      if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
      entries.set(req.id, { req, settle, timer })
      return { req, decision }
    },
    /** Settle a request by id; undefined when it already settled. */
    decide(id: string, decision: RequestDecision): PendingRequest | undefined {
      return finish(id, decision)
    },
    /** Live requests, optionally narrowed to one session. */
    list(session?: string): PendingRequest[] {
      return [...entries.values()]
        .map((e) => e.req)
        .filter((r) => session === undefined || r.session === session)
    },
    /** Settle every parked request (plugin disposal): outcome 'cancelled'. */
    cancelAll(): void {
      for (const id of [...entries.keys()]) finish(id, { approved: false, outcome: 'cancelled' })
    },
  }
}

type PendingQueue = ReturnType<typeof makePendingQueue>

// ── Audit log ────────────────────────────────────────────────────────────────

interface AuditEvent {
  event: 'grant' | 'grant-extend' | 'expire' | 'revoke' | 'rw-issue' | 'gated-issue' | 'ledger-reset' | 'grant-request' | 'request-decide' | 'deny' | 'undeny' | 'deny-block'
  /** Absent on ledger-reset, which is process-scoped, not session-scoped. */
  session?: string
  /** The dispatching session, when the caller is a spawned sub-agent (血缘归因). */
  parentSession?: string
  kind?: string
  name?: string
  reason?: string
  approvedBy?: string
  expiresAt?: number
  /** grant-request: the TTL the model asked for. */
  requestedTtlMinutes?: number
  /** grant / request-decide: the TTL actually granted. */
  ttlMinutes?: number
  /** grant-extend: the expiry before renewal (the new one is expiresAt). */
  previousExpiresAt?: number
  /** request-decide: approved, or the rejection outcome. */
  outcome?: string
  /** revoke: 'panel' (human via access panel) or 'agent' (request_access). */
  source?: string
}

/**
 * Append-only JSONL audit sink. Synchronous so a grant and its audit line can
 * never be reordered by a crash in between, and so tests read deterministic
 * output. A write failure must not break authorization — but an audit gap
 * matters, so it shouts on the server log.
 */
function makeAudit(file: string): (e: AuditEvent) => void {
  mkdirSync(dirname(file), { recursive: true })
  return (e) => {
    try {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n')
    } catch (err) {
      console.error('ops-access-gate: audit write failed for ' + file + ' (authorization continues, audit has a gap):', err)
    }
  }
}

/** Load persisted lockdowns. A missing or corrupt file yields an empty set — the audit log records what happened. */
export function loadDenied(file: string): DeniedEntry[] {
  let raw: { entries?: unknown }
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(raw.entries)) return []
  return raw.entries.filter((e): e is DeniedEntry =>
    typeof e === 'object' && e !== null
    && typeof (e as DeniedEntry).kind === 'string'
    && typeof (e as DeniedEntry).name === 'string'
    && typeof (e as DeniedEntry).deniedAt === 'number'
    && typeof (e as DeniedEntry).reason === 'string'
    && typeof (e as DeniedEntry).deniedBy === 'string')
}

/** Persist lockdowns synchronously (same crash-ordering discipline as the audit log). A failure shouts, never throws. */
export function saveDenied(file: string, entries: DeniedEntry[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.error('ops-access-gate: failed to persist lockdowns to ' + file + ' (the in-memory state still holds):', err)
  }
}

// ── Ledger ───────────────────────────────────────────────────────────────────

/**
 * Per-session grants. Preset-plane shared instance → keyed by session id, not
 * closure state. Expiry is lazy: a lapsed grant is evicted (and audit-logged)
 * the first time it is consulted — TTL is the reliable boundary, there is no
 * session-end event to hook.
 */
type Ledger = Map<string, Map<string, Grant>>

/** Stable key for a (kind, name) pair within one session's grant set. */
function grantKey(kind: string, name: string): string {
  return kind + ' ' + name
}

/** Persistence hook for the lockdown set: initial entries plus a change callback (apply wires it to deniedFile). */
interface DeniedStore {
  initial?: DeniedEntry[]
  onChange?: (entries: DeniedEntry[]) => void
}

function makeGate(ledger: Ledger, audit: (e: AuditEvent) => void, now: () => number, deniedStore: DeniedStore = {}): OpsAccessGate {
  const denied = new Map<string, DeniedEntry>()
  for (const d of deniedStore.initial ?? []) denied.set(grantKey(d.kind, d.name), d)
  function persistDenied(): void { deniedStore.onChange?.([...denied.values()]) }
  /** Fetch a grant, evicting + audit-logging it when lapsed. */
  function live(session: string, kind: string, name: string): Grant | undefined {
    const grant = ledger.get(session)?.get(grantKey(kind, name))
    if (!grant) return undefined
    if (grant.expiresAt <= now()) {
      ledger.get(session)!.delete(grantKey(kind, name))
      audit({ event: 'expire', session, kind, name })
      return undefined
    }
    return grant
  }

  return {
    authorize(grant: Grant): void {
      let set = ledger.get(grant.session)
      if (!set) ledger.set(grant.session, set = new Map())
      set.set(grantKey(grant.kind, grant.name), grant)
    },
    isAuthorized(session: string, kind: string, name: string): boolean {
      return live(session, kind, name) !== undefined
    },
    revoke(session: string, kind: string, name: string): boolean {
      return ledger.get(session)?.delete(grantKey(kind, name)) ?? false
    },
    listAll(): Array<ActiveGrant & { session: string }> {
      const out: Array<ActiveGrant & { session: string }> = []
      for (const [session, set] of ledger) {
        for (const grant of set.values()) {
          if (live(session, grant.kind, grant.name) === undefined) continue
          out.push({ session, kind: grant.kind, name: grant.name, expiresAt: grant.expiresAt, reason: grant.reason, approvedBy: grant.approvedBy })
        }
      }
      return out
    },
    list(session: string): ActiveGrant[] {
      const out: ActiveGrant[] = []
      for (const grant of ledger.get(session)?.values() ?? []) {
        if (live(session, grant.kind, grant.name) === undefined) continue
        out.push({ kind: grant.kind, name: grant.name, expiresAt: grant.expiresAt, reason: grant.reason, approvedBy: grant.approvedBy })
      }
      return out
    },
    deny(kind: string, name: string, reason: string, deniedBy: string): string[] {
      denied.set(grantKey(kind, name), { kind, name, deniedAt: now(), reason, deniedBy })
      persistDenied()
      audit({ event: 'deny', kind, name, reason, approvedBy: deniedBy })
      // A lockdown kills live elevation everywhere, not just future
      // resolves — revoke every session's grant for this profile.
      const affected: string[] = []
      for (const [session, set] of ledger) {
        if (set.delete(grantKey(kind, name))) {
          affected.push(session)
          audit({ event: 'revoke', session, kind, name, source: 'deny' })
        }
      }
      return affected
    },
    undeny(kind: string, name: string): boolean {
      if (!denied.delete(grantKey(kind, name))) return false
      persistDenied()
      audit({ event: 'undeny', kind, name })
      return true
    },
    isDenied(kind: string, name: string): boolean {
      return denied.has(grantKey(kind, name))
    },
    listDenied(): DeniedEntry[] {
      return [...denied.values()].sort((a, b) => a.deniedAt - b.deniedAt)
    },
  }
}

// ── HTTP helpers (copies of core's tiny helpers — core does not export them) ─

function readRequestBody(req: { on: (event: string, cb: (chunk?: Buffer | string) => void) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', () => reject(new Error('failed to read request body')))
  })
}

function sendJson(res: { writeHead: (s: number, h?: Record<string, string>) => void, end: (t: string) => void }, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function sendJsonError(res: { writeHead: (s: number, h?: Record<string, string>) => void, end: (t: string) => void }, status: number, err: unknown): void {
  sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
}

// ── request_access tool ──────────────────────────────────────────────────────

const REQUEST_ACCESS = 'request_access'

/** The exec context the tool runs under (structural subset of dsh's ToolRunContext). */
interface RequestAccessExec {
  signal?: AbortSignal
  agent?: AccessAgent
  callId?: unknown
}

interface ToolResult {
  ok: boolean
  message: string
}

/** Split "kind/name" on the FIRST slash — profile names may themselves contain '@' etc. */
function parseProfile(raw: unknown): { kind: string, profileName: string } | undefined {
  if (typeof raw !== 'string') return undefined
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { kind: raw.slice(0, slash), profileName: raw.slice(slash + 1) }
}

/**
 * Structural read of the caller's dispatching session (sub-agent lineage).
 * dsh records it on the session header as `parentSession`; AccessAgent stays
 * narrow ({ id }) on purpose, so the gate reads the rest structurally and
 * tolerates runtimes that expose nothing.
 */
function parentSessionOf(agent: unknown): string | undefined {
  const header = (agent as { session?: { header?: { parentSession?: unknown } } } | undefined)?.session?.header
  return typeof header?.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : undefined
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const audit = makeAudit(expandHome(config.auditFile))
  const ledger: Ledger = new Map()
  // Lockdowns persist (ticket 12): an incident freeze must survive a restart.
  const deniedFile = expandHome(config.deniedFile)
  const gate = makeGate(ledger, audit, () => Date.now(), {
    initial: loadDenied(deniedFile),
    onChange: (entries) => saveDenied(deniedFile, entries),
  })
  ctx.provide('opsAccessGate', gate)

  /** Per-session model-visible notices from panel actions, drained at pre-step. */
  const notices = new Map<string, string[]>()
  function queueNotice(session: string, text: string): void {
    const list = notices.get(session)
    if (list) list.push(text)
    else notices.set(session, [text])
  }

  const pending: PendingQueue = makePendingQueue(
    () => Date.now(),
    (req, decision) => audit({
      event: 'request-decide',
      session: req.session,
      kind: req.kind,
      name: req.name,
      outcome: decision.approved ? 'approved' : decision.outcome,
      ...(decision.approved ? { ttlMinutes: decision.ttlMinutes } : {}),
    }),
  )
  // The queue shares the ledger's lifetime: plugin disposal (HMR, shutdown)
  // settles every parked request as cancelled instead of leaking promises.
  ctx.effect(() => () => pending.cancelAll())

  // Set by the webServer block below; false in headless deployments, where
  // request_access must fail fast with out-of-band guidance.
  let humanChannelAvailable = false

  // apply runs on boot and on every HMR reload — both start a fresh, empty
  // ledger. Record the reset so an auditor can tell "grants were cleared" from
  // "nothing was ever granted".
  audit({ event: 'ledger-reset' })

  // The broker is a pure decision function consulted on EVERY resolve once
  // registered — including calls without an agent. The no-agent ruling is
  // policy and lives here, not in core: tiered kinds fail closed to ro (rw is
  // never issued without a session to key the grant on); approval-required
  // kinds deny outright — their credential is effectively rw (there is no
  // read-only shell), so an untracked caller must not get it at all.
  const broker: AccessBroker = (kind, profileName, agent) => {
    // Deny (ticket 12) outranks every other state: a locked profile refuses
    // even ro, for session and internal callers alike.
    if (gate.isDenied(kind, profileName)) {
      audit({ event: 'deny-block', ...(agent ? { session: agent.id } : {}), kind, name: profileName })
      return { deny: kind + '/' + profileName + ' is locked by the operator — even read-only access is refused until the lockdown is lifted' }
    }
    if (!agent) {
      if (config.approvalRequiredKinds.includes(kind)) {
        return { deny: kind + ' requires an approved grant, and grants need a session — internal calls without one cannot use it. Call it from a session and request timed access via the ' + REQUEST_ACCESS + ' tool' }
      }
      return 'ro'
    }
    const authorized = gate.isAuthorized(agent.id, kind, profileName)
    // Approval-required kinds (ssh): the credential lives in the ro registry —
    // the grant is a timed pass to use it at all.
    if (config.approvalRequiredKinds.includes(kind)) {
      if (authorized) {
        audit({ event: 'gated-issue', session: agent.id, parentSession: parentSessionOf(agent), kind, name: profileName })
        return 'ro'
      }
      return { deny: kind + ' has no read-only tier; request timed access via the ' + REQUEST_ACCESS + ' tool (profile "' + kind + '/' + profileName + '", with a reason)' }
    }
    if (authorized) {
      audit({ event: 'rw-issue', session: agent.id, parentSession: parentSessionOf(agent), kind, name: profileName })
      return 'rw'
    }
    return 'ro'
  }
  registerAccessBroker(ctx, broker)

  // The /access slash command opens the access panel (ops-panel seam). The
  // command is agent-scoped: it exists only in presets that mount this plugin.
  // Registered via deferred inject — deployments without the commands service
  // (headless) simply never get the command instead of failing to load.
  ctx.inject(['commands'], (commandCtx: Context) => {
    registerPanelCommand(commandCtx, { name: 'access', description: '打开授权面板 — 授予 / 调整 / 收回本会话的提权访问' })
    registerPanelCommand(commandCtx, { name: 'access-all', description: '打开授权总览 — 跨会话查看与收回提权授权（含待决申请与封禁列表）' })
  })

  // ── Human-side routes (the access panel's backend) ─────────────────────────
  // Preset-plane registration of host webServer routes, same discipline as
  // core's /ops-access/list: the route lives next to the data, plain HTTP, no
  // TypertRemoteService (dual-module-instance lesson). The webServer matches
  // by path only, so handlers dispatch on req.method.
  ctx.inject(['webServer'], (wctx: Context) => {
    wctx.effect(() => {
      humanChannelAvailable = true
      return () => { humanChannelAvailable = false }
    })
    const ws = wctx as unknown as { webServer: { register(route: unknown): () => void } }

    /** Shared deliverability check: the tier a grant would issue must resolve. */
    async function checkDeliverable(kind: string, profileName: string): Promise<string | null> {
      const opsAccess = ctx.get('opsAccess')
      if (!opsAccess) return 'ops-access service unavailable — is the ops-access plugin mounted in this preset?'
      if (config.approvalRequiredKinds.includes(kind)) {
        return (await opsAccess.canResolve(kind, profileName, 'ro')).ok
          ? null
          : 'no resolvable profile "' + kind + '/' + profileName + '" in the access registry'
      }
      return (await opsAccess.canResolve(kind, profileName, 'rw')).ok
        ? null
        : kind + '/' + profileName + ' has no usable rw tier registered, so a grant could not be fulfilled'
    }

    /** Validate a TTL choice against the configured panel options. */
    function ttlOptionError(raw: unknown): number | null {
      if (typeof raw !== 'number' || !config.grantTtlOptions.includes(raw)) return null
      return raw
    }

    const ttlOptionsMessage = 'ttlMinutes must be one of the configured options: ' + config.grantTtlOptions.join(', ')

    // GET /ops-access/grants?session=<id> — the session's live grants.
    // POST /ops-access/grants — a panel grant {session, kind, name, ttlMinutes, reason?}.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/grants',
      handler: async (req: { url: string, method: string, on: unknown }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method === 'GET') {
            const session = new URL(req.url, 'http://localhost').searchParams.get('session') ?? ''
            if (session === '') { sendJsonError(res, 400, new Error('session query parameter is required')); return }
            const grants = gate.list(session).map((g) => ({
              ...g,
              remainingMinutes: Math.max(0, Math.round((g.expiresAt - Date.now()) / 60000)),
            }))
            // The TTL choices ride along so the panel never hardcodes them.
            sendJson(res, 200, { ok: true, grants, ttlOptions: config.grantTtlOptions, denied: gate.listDenied() })
            return
          }
          if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const body = JSON.parse(await readRequestBody(req as never)) as Record<string, unknown>
          const { session, kind, name } = body
          if (typeof session !== 'string' || session === '' || typeof kind !== 'string' || kind === '' || typeof name !== 'string' || name === '') {
            sendJsonError(res, 400, new Error('session, kind, and name (non-empty strings) are required'))
            return
          }
          const ttl = ttlOptionError(body.ttlMinutes)
          if (ttl === null) { sendJsonError(res, 400, new Error(ttlOptionsMessage)); return }
          if (gate.isDenied(kind, name)) { sendJsonError(res, 400, new Error(kind + '/' + name + ' is locked (deny) — lift the lockdown first')); return }
          const undeliverable = await checkDeliverable(kind, name)
          if (undeliverable !== null) { sendJsonError(res, 400, new Error(undeliverable)); return }
          const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : 'operator panel grant'
          const expiresAt = Date.now() + ttl * 60000
          gate.authorize({ session, kind, name, expiresAt, reason, approvedBy: 'panel' })
          audit({ event: 'grant', session, kind, name, reason, approvedBy: 'panel', expiresAt, ttlMinutes: ttl })
          const approvalRequired = config.approvalRequiredKinds.includes(kind)
          queueNotice(session,
            '<access-grant>运维通过授权面板授予本会话 ' + kind + '/' + name
            + (approvalRequired ? ' 的限时使用权限' : ' 的 rw 权限')
            + '，至 ' + new Date(expiresAt).toISOString() + '（' + ttl + ' 分钟）</access-grant>')
          sendJson(res, 200, { ok: true, expiresAt })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // POST /ops-access/grants/revoke — drop one grant {session, kind, name}.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/grants/revoke',
      handler: async (req: { method: string, on: unknown }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const body = JSON.parse(await readRequestBody(req as never)) as Record<string, unknown>
          const { session, kind, name } = body
          if (typeof session !== 'string' || session === '' || typeof kind !== 'string' || kind === '' || typeof name !== 'string' || name === '') {
            sendJsonError(res, 400, new Error('session, kind, and name (non-empty strings) are required'))
            return
          }
          const removed = gate.revoke(session, kind, name)
          if (!removed) { sendJsonError(res, 400, new Error('no active grant for ' + kind + '/' + name + ' in this session')); return }
          audit({ event: 'revoke', session, kind, name, source: 'panel' })
          queueNotice(session, '<access-revoked>运维收回了本会话 ' + kind + '/' + name + ' 的提权权限，已回落只读</access-revoked>')
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // POST /ops-access/grants/extend — renew one active grant {session, kind, name, ttlMinutes}.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/grants/extend',
      handler: async (req: { method: string, on: unknown }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const body = JSON.parse(await readRequestBody(req as never)) as Record<string, unknown>
          const { session, kind, name } = body
          if (typeof session !== 'string' || session === '' || typeof kind !== 'string' || kind === '' || typeof name !== 'string' || name === '') {
            sendJsonError(res, 400, new Error('session, kind, and name (non-empty strings) are required'))
            return
          }
          const ttl = ttlOptionError(body.ttlMinutes)
          if (ttl === null) { sendJsonError(res, 400, new Error(ttlOptionsMessage)); return }
          // gate.list filters expired grants — an expired grant cannot be
          // extended; grant it anew instead.
          const active = gate.list(session).find((g) => g.kind === kind && g.name === name)
          if (!active) { sendJsonError(res, 400, new Error('no active grant for ' + kind + '/' + name + ' in this session — expired grants cannot be extended')); return }
          // Renew from NOW, not from the old expiry: repeated extends must
          // never accumulate past one TTL tier — the ceiling discipline holds.
          const expiresAt = Date.now() + ttl * 60000
          gate.authorize({ session, kind, name, expiresAt, reason: active.reason, approvedBy: active.approvedBy })
          audit({ event: 'grant-extend', session, kind, name, expiresAt, ttlMinutes: ttl, previousExpiresAt: active.expiresAt })
          queueNotice(session,
            '<access-grant>运维延长了本会话 ' + kind + '/' + name + ' 的授权，新到期时间 '
            + new Date(expiresAt).toISOString() + '（' + ttl + ' 分钟）</access-grant>')
          sendJson(res, 200, { ok: true, expiresAt })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // GET /ops-access/grants/all — every session's live grants + parked requests + lockdowns (ticket 13's overview).
    // Revocation reuses the per-session routes; request decisions reuse the decide route.
    // The TTL choices ride along so the overview can approve with an adjusted lifetime.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/grants/all',
      handler: async (req: { method: string }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'GET') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const grants = gate.listAll().map((g) => ({
            ...g,
            remainingMinutes: Math.max(0, Math.round((g.expiresAt - Date.now()) / 60000)),
          }))
          sendJson(res, 200, { ok: true, grants, requests: pending.list(), denied: gate.listDenied(), ttlOptions: config.grantTtlOptions })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // POST /ops-access/deny — lock a profile outright {kind, name, reason?}:
    // even ro is refused, and its live grants die in every session.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/deny',
      handler: async (req: { method: string, on: unknown }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const body = JSON.parse(await readRequestBody(req as never)) as Record<string, unknown>
          const { kind, name } = body
          if (typeof kind !== 'string' || kind === '' || typeof name !== 'string' || name === '') {
            sendJsonError(res, 400, new Error('kind and name (non-empty strings) are required'))
            return
          }
          const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : 'operator lockdown'
          const affected = gate.deny(kind, name, reason, 'panel')
          for (const session of affected) {
            queueNotice(session, '<access-revoked>运维封禁了 ' + kind + '/' + name + '（' + reason + '）：本会话的相关授权已收回，该档案连只读访问也已锁定</access-revoked>')
          }
          sendJson(res, 200, { ok: true, revokedSessions: affected.length })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // POST /ops-access/undeny — lift a lockdown {kind, name}.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/undeny',
      handler: async (req: { method: string, on: unknown }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const body = JSON.parse(await readRequestBody(req as never)) as Record<string, unknown>
          const { kind, name } = body
          if (typeof kind !== 'string' || kind === '' || typeof name !== 'string' || name === '') {
            sendJsonError(res, 400, new Error('kind and name (non-empty strings) are required'))
            return
          }
          if (!gate.undeny(kind, name)) { sendJsonError(res, 400, new Error(kind + '/' + name + ' is not locked')); return }
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // POST /ops-access/grants/revoke-all — drop every grant of one session.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/grants/revoke-all',
      handler: async (req: { method: string, on: unknown }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const body = JSON.parse(await readRequestBody(req as never)) as Record<string, unknown>
          const session = body.session
          if (typeof session !== 'string' || session === '') {
            sendJsonError(res, 400, new Error('session (non-empty string) is required'))
            return
          }
          const grants = gate.list(session)
          for (const g of grants) {
            gate.revoke(session, g.kind, g.name)
            audit({ event: 'revoke', session, kind: g.kind, name: g.name, source: 'panel' })
          }
          if (grants.length > 0) {
            queueNotice(session, '<access-revoked>运维收回了本会话的全部提权授权（' + grants.length + ' 项），已回落只读</access-revoked>')
          }
          sendJson(res, 200, { ok: true, revoked: grants.length })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // GET /ops-access/access-requests?session=<id> — pending requests (polled).
    // Returns the session's own requests PLUS its delegated children's: a
    // sub-agent's parked request rides the sub-session id, but the operator
    // working in the parent session must see and decide it there (血缘).
    // POST /ops-access/access-requests — unused; requests come from the tool.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/access-requests',
      handler: async (req: { url: string, method: string }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'GET') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const session = new URL(req.url, 'http://localhost').searchParams.get('session') ?? ''
          if (session === '') { sendJsonError(res, 400, new Error('session query parameter is required')); return }
          const own = pending.list(session)
          const delegated = pending.list().filter((r) => r.parentSession === session)
          sendJson(res, 200, { ok: true, requests: [...own, ...delegated] })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    // POST /ops-access/access-requests/decide — {id, approved, ttlMinutes?}.
    wctx.effect(() => ws.webServer.register({
      kind: 'exact',
      path: '/ops-access/access-requests/decide',
      handler: async (req: { method: string, on: unknown }, res: Parameters<typeof sendJson>[0]) => {
        try {
          if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
          const body = JSON.parse(await readRequestBody(req as never)) as Record<string, unknown>
          const { id, approved } = body
          if (typeof id !== 'string' || id === '' || typeof approved !== 'boolean') {
            sendJsonError(res, 400, new Error('id (string) and approved (boolean) are required'))
            return
          }
          let decision: RequestDecision
          if (approved) {
            const ttl = ttlOptionError(body.ttlMinutes)
            if (ttl === null) { sendJsonError(res, 400, new Error(ttlOptionsMessage)); return }
            decision = { approved: true, ttlMinutes: ttl }
          } else {
            decision = { approved: false, outcome: 'rejected' }
          }
          const settled = pending.decide(id, decision)
          if (!settled) { sendJsonError(res, 404, new Error('no pending request ' + id + ' (already decided or expired)')); return }
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))
  })

  // ── Panel → agent notices (symmetric notification, ADR-0004 决策 5) ───────
  // The command surface never enters model history, so panel grants/revokes
  // would be invisible to the agent. Notices queue per session and drain
  // through agent.inject at the next pre-step — the durable inbox splice, so
  // model-visible ⟺ logged holds.
  ;(ctx.on as (event: string, listener: (payload: unknown, next: () => Promise<unknown>) => unknown, options?: unknown) => void)(
    'agent/pre-step',
    async (payload: unknown, next: () => Promise<unknown>) => {
      const decision = await next() as { kind: string }
      if (decision.kind === 'reject') return decision
      const agent = (payload as { agent?: { id?: string, inject?: (message: unknown) => void } } | undefined)?.agent
      if (!agent || typeof agent.id !== 'string' || typeof agent.inject !== 'function') return decision
      const queued = notices.get(agent.id)
      if (!queued || queued.length === 0) return decision
      notices.delete(agent.id)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: queued.join('\n') }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'access grant change' },
      }))
      return decision
    },
    { prepend: true },
  )

  ctx.effect(() => ctx.tools.register(defineTool({
    name: REQUEST_ACCESS,
    description:
      'Request time-limited elevated access to an ops profile, list this ' +
      'session\'s active grants, or revoke one. A human decides each request in ' +
      'the access panel and may adjust the requested lifetime to a shorter ' +
      'option; the result reports the lifetime actually granted. Elevated (rw) ' +
      'credentials lapse automatically at the TTL.',
    parameters: {
      action: { type: 'string', enum: ['request', 'list', 'revoke'], required: true, description: 'request: ask a human for a timed grant; list: show this session\'s active grants; revoke: drop a grant immediately.' },
      profile: { type: 'string', description: '"kind/name", e.g. "k8s/prod". Required for request and revoke.' },
      reason: { type: 'string', description: 'Why the access is needed — shown verbatim to the human approver. Required for request.' },
      ttlMinutes: { type: 'number', description: 'Requested grant lifetime in minutes (default ' + config.defaultTtlMinutes + ', max ' + config.maxTtlMinutes + '). The human may approve a shorter lifetime from the panel options: ' + config.grantTtlOptions.join(', ') + '.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      // Pure function of (args, value): same inputs, same text, no state touched.
      render: (_args: unknown, value: ToolResult) => [{ type: 'text' as const, text: value.message }],
    },
    async execute(args: Record<string, unknown>, exec: RequestAccessExec): Promise<ToolResult> {
      const action = args.action as string
      const agent = exec.agent
      // Fail closed: no agent means an internal (non-session) caller, and
      // grants have nothing to key on.
      if (!agent) {
        return { ok: false, message: REQUEST_ACCESS + ' requires a session context; internal calls cannot hold grants' }
      }

      if (action === 'list') {
        const grants = gate.list(agent.id)
        if (grants.length === 0) return { ok: true, message: 'No active grants in this session.' }
        const lines = grants.map((g) => {
          const remaining = Math.max(0, Math.round((g.expiresAt - Date.now()) / 60000))
          return '- ' + g.kind + '/' + g.name + ' — ' + remaining + ' min left (approved by ' + g.approvedBy + ') — ' + g.reason
        })
        return { ok: true, message: 'Active grants:\n' + lines.join('\n') }
      }

      const parsed = parseProfile(args.profile)
      if (!parsed) {
        return { ok: false, message: 'profile must be "kind/name", e.g. "k8s/prod"' }
      }
      const { kind, profileName } = parsed

      if (action === 'revoke') {
        const removed = gate.revoke(agent.id, kind, profileName)
        if (removed) audit({ event: 'revoke', session: agent.id, kind, name: profileName, source: 'agent' })
        return removed
          ? { ok: true, message: 'Revoked ' + kind + '/' + profileName + '; this session is back to read-only for it.' }
          : { ok: false, message: 'No active grant for ' + kind + '/' + profileName + ' in this session.' }
      }

      // action === 'request'
      // A locked profile can never be granted — fail fast instead of parking.
      if (gate.isDenied(kind, profileName)) {
        return { ok: false, message: kind + '/' + profileName + ' is locked by the operator (deny) — no access can be granted until the lockdown is lifted. The request was not sent.' }
      }
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') {
        return { ok: false, message: 'request requires a non-empty reason — it is shown to the human approver' }
      }

      // Headless fast-fail: the access panel is the approval channel, and its
      // routes live on the web server. No web server → nobody can ever decide
      // — error immediately instead of parking until the timeout.
      if (!humanChannelAvailable) {
        return { ok: false, message: 'No approval channel in this deployment (headless — the access panel needs the web server). Ask the operator to grant access out of band.' }
      }

      // Deliverability checks BEFORE parking the request. All go through
      // canResolve — an explicit metadata query that validates like resolve
      // but never consults the broker and never returns fields. The tier that
      // must resolve is the tier the grant would ISSUE:
      // - Approval-required kinds (ssh): the credential lives in the ro tier.
      // - Tiered kinds: the grant issues rw, so only rw must resolve. ro is
      //   deliberately NOT required — an rw-only profile is exactly the
      //   bootstrap case where the agent derives and registers ro itself
      //   (register_access), and refusing the grant would deadlock that flow.
      const opsAccess = ctx.get('opsAccess')
      if (!opsAccess) {
        return { ok: false, message: 'ops-access service unavailable — is the ops-access plugin mounted in this preset?' }
      }
      if (config.approvalRequiredKinds.includes(kind)) {
        if (!(await opsAccess.canResolve(kind, profileName, 'ro')).ok) {
          return { ok: false, message: 'no resolvable profile "' + kind + '/' + profileName + '" in the access registry (unknown kind, unknown name, or invalid entry). Run list_access to see available profiles. The request was not sent.' }
        }
      } else if (!(await opsAccess.canResolve(kind, profileName, 'rw')).ok) {
        // Distinguish "entry exists but its rw tier is missing/broken" from
        // "no such entry at all" — the guidance differs.
        if ((await opsAccess.canResolve(kind, profileName, 'ro')).ok) {
          return { ok: false, message: kind + '/' + profileName + ' has no usable rw tier registered (missing or invalid entry in the rw registry), so a grant could not be fulfilled. Ask the operator to fix the rw credential first. The request was not sent.' }
        }
        return { ok: false, message: 'no resolvable profile "' + kind + '/' + profileName + '" in the access registry (unknown kind, unknown name, or invalid entry). Run list_access to see available profiles. The request was not sent.' }
      }

      const requested = typeof args.ttlMinutes === 'number' ? args.ttlMinutes : config.defaultTtlMinutes
      const ttl = Math.min(Math.max(1, Math.round(requested)), config.maxTtlMinutes)

      // Park the request for a human decision in the access panel. The
      // dispatching session rides along (血缘): the approver sees when a
      // request comes from a spawned sub-agent, and whose it is.
      const parentSession = parentSessionOf(agent)
      audit({ event: 'grant-request', session: agent.id, parentSession, kind, name: profileName, reason, requestedTtlMinutes: ttl })
      const { req, decision } = pending.add(
        { session: agent.id, parentSession, kind, name: profileName, requestedTtlMinutes: ttl, reason },
        config.pendingRequestTimeoutMinutes,
      )
      // A dead tool call (turn aborted) settles the request as cancelled.
      const onAbort = () => pending.decide(req.id, { approved: false, outcome: 'cancelled' })
      exec.signal?.addEventListener('abort', onAbort)
      let settled: RequestDecision
      try {
        settled = await decision
      } finally {
        exec.signal?.removeEventListener('abort', onAbort)
      }

      if (!settled.approved) {
        const why = settled.outcome === 'timeout'
          ? 'no operator decision within ' + config.pendingRequestTimeoutMinutes + ' min'
          : settled.outcome === 'cancelled'
            ? 'cancelled'
            : 'rejected by the operator'
        return { ok: false, message: 'Access to ' + kind + '/' + profileName + ' was not granted (' + why + ').' }
      }

      const expiresAt = Date.now() + settled.ttlMinutes * 60000
      gate.authorize({ session: agent.id, kind, name: profileName, expiresAt, reason, approvedBy: 'user' })
      audit({
        event: 'grant',
        session: agent.id,
        parentSession,
        kind,
        name: profileName,
        reason,
        approvedBy: 'user',
        expiresAt,
        ttlMinutes: settled.ttlMinutes,
        ...(settled.ttlMinutes !== ttl ? { requestedTtlMinutes: ttl } : {}),
      })
      const adjusted = settled.ttlMinutes !== ttl
        ? ' — the operator adjusted your requested ' + ttl + ' min to ' + settled.ttlMinutes + ' min'
        : ''
      return { ok: true, message: 'Granted ' + kind + '/' + profileName + ' until ' + new Date(expiresAt).toISOString() + ' (' + settled.ttlMinutes + ' min' + adjusted + '). Elevated credentials apply to this session only.' }
    },
  })))
}
