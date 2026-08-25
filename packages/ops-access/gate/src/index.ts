/**
 * Ops access gate — per-session credential brokering with human approval.
 *
 * This plugin owns the **authorization ledger**: an in-process map keyed by
 * session id (`exec.agent.id`). It registers a **pure-decision broker** into
 * the ops-access seam via {@link registerAccessBroker}; that broker answers
 * `'rw'` when the calling session holds an unexpired grant for the profile,
 * `'ro'` otherwise, and `{ deny }` for approval-required kinds (ssh) without
 * a grant. Calls without an agent (system-internal) are ruled here too:
 * tiered kinds fail closed to ro, approval-required kinds deny outright. Core
 * then serves the profile from the matching registry file (ro → access.yaml,
 * rw → access-rw.yaml). The gate never sees credential fields — kind, profile
 * name, and session id are its whole world.
 *
 * Grants are created explicitly: the model calls the `request_access` tool
 * with a profile and a reason, the gate asks the human through dsh's native
 * approval channel (`ctx.approval`), and only an `'allowed-once'` outcome
 * writes the grant. Grants carry a TTL — expiry is the only reliable
 * fallback boundary (a web session has no dependable end event). Every
 * grant, expiry, revoke, elevated issue, and ledger reset (boot / HMR
 * reload) lands in a JSONL audit file.
 *
 * @module @deepseek-ai/dsh-ops-access-gate
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AccessAgent, AccessBroker } from '@deepseek-ai/dsh-ops-access'
import { expandHome, registerAccessBroker } from '@deepseek-ai/dsh-ops-access'

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
  /** JSONL audit log path; a leading `~` expands to $HOME. */
  auditFile: string
}

export const Config: z<Config> = z.object({
  approvalRequiredKinds: z.array(z.string()).default(['ssh']),
  defaultTtlMinutes: z.number().default(30),
  maxTtlMinutes: z.number().default(480),
  auditFile: z.string().default('~/.dsh-ops/audit.log'),
})

// ── Grant + service contract ─────────────────────────────────────────────────

/**
 * One authorization: session S may use elevated credentials for `kind`/`name`
 * until `expiresAt`. Grants are in-process only — a dsh restart clears them,
 * which is acceptable: they are short-lived by design.
 */
export interface Grant {
  /** Session id (`exec.agent.id`) this grant is scoped to. */
  readonly session: string
  readonly kind: string
  readonly name: string
  /** Epoch ms when the grant lapses. */
  readonly expiresAt: number
  /** The reason the model stated and the human approved. */
  readonly reason: string
  /** Who approved; 'user' via the approval channel. */
  readonly approvedBy: string
}

/** A live grant as reported by `list` (session key omitted — it is the query). */
export interface ActiveGrant {
  readonly kind: string
  readonly name: string
  readonly expiresAt: number
  readonly reason: string
  readonly approvedBy: string
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
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsAccessGate?: OpsAccessGate
  }
}

// ── Approval channel (structural — no dependency on the approval package) ────

/** Closed outcome vocabulary, mirroring dsh's ApprovalOutcome. */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The slice of dsh's approval service this plugin uses, declared structurally
 * (same discipline as dsh's own sandbox escalation): the agent and callId are
 * opaque pass-throughs, so no type dependency on dsh-agent/dsh-user-approval.
 */
interface ApprovalChannel {
  request(req: {
    agent: unknown
    toolName: string
    callId?: unknown
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

// ── Audit log ────────────────────────────────────────────────────────────────

interface AuditEvent {
  event: 'grant' | 'expire' | 'revoke' | 'rw-issue' | 'gated-issue' | 'ledger-reset'
  /** Absent on ledger-reset, which is process-scoped, not session-scoped. */
  session?: string
  kind?: string
  name?: string
  reason?: string
  approvedBy?: string
  expiresAt?: number
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
      console.error(`ops-access-gate: audit write failed for ${file} (authorization continues, audit has a gap):`, err)
    }
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
  return `${kind}${name}`
}

function makeGate(ledger: Ledger, audit: (e: AuditEvent) => void, now: () => number): OpsAccessGate {
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
    list(session: string): ActiveGrant[] {
      const out: ActiveGrant[] = []
      for (const grant of ledger.get(session)?.values() ?? []) {
        if (live(session, grant.kind, grant.name) === undefined) continue
        out.push({ kind: grant.kind, name: grant.name, expiresAt: grant.expiresAt, reason: grant.reason, approvedBy: grant.approvedBy })
      }
      return out
    },
  }
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

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const audit = makeAudit(expandHome(config.auditFile))
  const ledger: Ledger = new Map()
  const gate = makeGate(ledger, audit, () => Date.now())
  ctx.provide('opsAccessGate', gate)

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
    if (!agent) {
      if (config.approvalRequiredKinds.includes(kind)) {
        return { deny: `${kind} requires an approved grant, and grants need a session — internal calls without one cannot use it. Call it from a session and request timed access via the ${REQUEST_ACCESS} tool` }
      }
      return 'ro'
    }
    const authorized = gate.isAuthorized(agent.id, kind, profileName)
    // Approval-required kinds (ssh): the credential lives in the ro registry —
    // the grant is a timed pass to use it at all.
    if (config.approvalRequiredKinds.includes(kind)) {
      if (authorized) {
        audit({ event: 'gated-issue', session: agent.id, kind, name: profileName })
        return 'ro'
      }
      return { deny: `${kind} has no read-only tier; request timed access via the ${REQUEST_ACCESS} tool (profile "${kind}/${profileName}", with a reason)` }
    }
    if (authorized) {
      audit({ event: 'rw-issue', session: agent.id, kind, name: profileName })
      return 'rw'
    }
    return 'ro'
  }
  registerAccessBroker(ctx, broker)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: REQUEST_ACCESS,
    description:
      'Request time-limited elevated access to an ops profile (a human approves each request), ' +
      'list this session\'s active grants, or revoke one. Elevated (rw) credentials are issued ' +
      'only after approval and lapse automatically at the TTL.',
    parameters: {
      action: { type: 'string', enum: ['request', 'list', 'revoke'], required: true, description: 'request: ask a human for a timed grant; list: show this session\'s active grants; revoke: drop a grant immediately.' },
      profile: { type: 'string', description: '"kind/name", e.g. "k8s/prod". Required for request and revoke.' },
      reason: { type: 'string', description: 'Why the access is needed — shown verbatim to the human approver. Required for request.' },
      ttlMinutes: { type: 'number', description: `Requested grant lifetime in minutes (default ${config.defaultTtlMinutes}, max ${config.maxTtlMinutes}).` },
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
        return { ok: false, message: `${REQUEST_ACCESS} requires a session context; internal calls cannot hold grants` }
      }

      if (action === 'list') {
        const grants = gate.list(agent.id)
        if (grants.length === 0) return { ok: true, message: 'No active grants in this session.' }
        const lines = grants.map((g) => {
          const remaining = Math.max(0, Math.round((g.expiresAt - Date.now()) / 60000))
          return `- ${g.kind}/${g.name} — ${remaining} min left (approved by ${g.approvedBy}) — ${g.reason}`
        })
        return { ok: true, message: `Active grants:\n${lines.join('\n')}` }
      }

      const parsed = parseProfile(args.profile)
      if (!parsed) {
        return { ok: false, message: 'profile must be "kind/name", e.g. "k8s/prod"' }
      }
      const { kind, profileName } = parsed

      if (action === 'revoke') {
        const removed = gate.revoke(agent.id, kind, profileName)
        if (removed) audit({ event: 'revoke', session: agent.id, kind, name: profileName })
        return removed
          ? { ok: true, message: `Revoked ${kind}/${profileName}; this session is back to read-only for it.` }
          : { ok: false, message: `No active grant for ${kind}/${profileName} in this session.` }
      }

      // action === 'request'
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') {
        return { ok: false, message: 'request requires a non-empty reason — it is shown to the human approver' }
      }

      // Deliverability checks BEFORE bothering the human. Both go through
      // canResolve — an explicit metadata query that validates like resolve
      // but never consults the broker and never returns fields.
      // 1. The profile itself must resolve from the ro registry.
      // 2. For tiered kinds a grant is only fulfillable when the rw registry
      //    actually carries a valid entry. (Approval-required kinds like ssh
      //    are exempt — their credential lives in the ro registry; the grant
      //    is the pass.)
      const opsAccess = ctx.get('opsAccess')
      if (!opsAccess) {
        return { ok: false, message: 'ops-access service unavailable — is the ops-access plugin mounted in this preset?' }
      }
      if (!(await opsAccess.canResolve(kind, profileName, 'ro')).ok) {
        return { ok: false, message: `no resolvable profile "${kind}/${profileName}" in the access registry (unknown kind, unknown name, or invalid entry). Run list_access to see available profiles. Approval was not requested.` }
      }
      if (!config.approvalRequiredKinds.includes(kind) && !(await opsAccess.canResolve(kind, profileName, 'rw')).ok) {
        return { ok: false, message: `${kind}/${profileName} has no usable rw tier registered (missing or invalid entry in the rw registry), so a grant could not be fulfilled. Ask the operator to fix the rw credential first. Approval was not requested.` }
      }

      const requested = typeof args.ttlMinutes === 'number' ? args.ttlMinutes : config.defaultTtlMinutes
      const ttl = Math.min(Math.max(1, Math.round(requested)), config.maxTtlMinutes)

      const approval = ctx.get('approval') as ApprovalChannel | undefined
      if (!approval) {
        return { ok: false, message: 'No approval channel in this deployment (headless?). Ask the operator to grant access out of band.' }
      }
      let outcome: ApprovalOutcome
      try {
        outcome = await approval.request({
          agent,
          toolName: REQUEST_ACCESS,
          callId: exec.callId,
          reason: `elevated access to ${kind}/${profileName} for ${ttl} min — ${reason}`,
          signal: exec.signal,
        })
      } catch (err) {
        return { ok: false, message: `approval request failed: ${String((err as Error | null)?.message || err)}` }
      }
      if (outcome !== 'allowed-once') {
        return { ok: false, message: `Access to ${kind}/${profileName} was not granted (${outcome}).` }
      }

      const expiresAt = Date.now() + ttl * 60000
      gate.authorize({ session: agent.id, kind, name: profileName, expiresAt, reason, approvedBy: 'user' })
      audit({ event: 'grant', session: agent.id, kind, name: profileName, reason, approvedBy: 'user', expiresAt })
      return { ok: true, message: `Granted ${kind}/${profileName} until ${new Date(expiresAt).toISOString()} (${ttl} min). Elevated credentials apply to this session only.` }
    },
  })))
}
