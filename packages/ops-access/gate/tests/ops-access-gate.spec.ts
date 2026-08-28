/**
 * Unit spec for ops-access-gate: mounts core + gate together and drives the
 * externally observable seam — resolve serves ro vs rw fields depending on
 * the ledger, grants are isolated by session, a missing agent is fail-closed,
 * request_access parks in the pending-request queue until the decide route
 * settles it (ADR-0004: the access panel is the approval channel), the panel
 * routes grant/revoke directly, TTL expiry and notices behave, ssh is gated
 * per-use, and every transition lands in the audit log.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { setup, REGISTRY, SSH_REGISTRY } from './harness.ts'

const SESSION_A = { id: 'sess-a' }
const SESSION_B = { id: 'sess-b' }

/** A grant that expires 30 minutes from now. */
function futureGrant(session: string, kind: string, name: string): plugin.Grant {
  return { session, kind, name, expiresAt: Date.now() + 30 * 60000, reason: 'test reason', approvedBy: 'user' }
}

/** Poll the access-requests route until one request appears for the session. */
async function awaitPending(h: ReturnType<typeof setup>, session: string) {
  for (let i = 0; i < 100; i++) {
    const res = await h.callRoute('/ops-access/access-requests', { query: '?session=' + session })
    if (res.json.requests.length > 0) return res.json.requests[0]
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('no pending request appeared for ' + session)
}

/** Drive a request_access call to its parked state, then decide it via the route. */
async function requestAndDecide(
  h: ReturnType<typeof setup>,
  args: Record<string, unknown>,
  exec: Record<string, unknown>,
  decision: { approved: boolean, ttlMinutes?: number },
) {
  const call = h.callRequestAccess(args, exec)
  const req = await awaitPending(h, (exec.agent as { id: string }).id)
  const decide = await h.callRoute('/ops-access/access-requests/decide', {
    method: 'POST',
    body: { id: req.id, ...decision },
  })
  return { result: await call, decide, req }
}

/** Run every agent/pre-step listener once (core's mention listener AND the
 * gate's notice drain share the event), capturing messages injected into the
 * given session's agent. */
async function drainNotices(h: ReturnType<typeof setup>, sessionId: string) {
  const matching = h.listeners.filter((l) => l.event === 'agent/pre-step')
  if (matching.length === 0) throw new Error('no agent/pre-step listener registered')
  const injected: string[] = []
  const agent = {
    id: sessionId,
    inject: (message: any) => {
      for (const block of message.content) injected.push(block.text)
    },
  }
  for (const l of matching) {
    await l.listener({ agent }, async () => ({ kind: 'enter', messages: [] }))
  }
  return injected
}

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access-gate')
    expect(plugin.inject).toEqual(['tools'])
    expect(typeof plugin.apply).toBe('function')
  })
})

// ── Brokering: ro vs rw ──────────────────────────────────────────────────────

describe('brokering', () => {
  it('no grant → ro fields served from the ro tier', async () => {
    const { opsAccess, writeRegistry } = setup()
    writeRegistry(REGISTRY)
    const profile = await opsAccess.resolve('test', 'prod', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://ro-prod.internal')
  })

  it('grant for the session → rw fields served from the rw tier', async () => {
    const { opsAccess, gate, writeRegistry } = setup()
    writeRegistry(REGISTRY)
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    const profile = await opsAccess.resolve('test', 'prod', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://rw-prod.internal')
  })

  it('grant for a different profile does not elevate the requested one', async () => {
    const { opsAccess, gate, writeRegistry } = setup()
    writeRegistry(REGISTRY
      + '  staging:' + String.fromCharCode(10) + '    ro:' + String.fromCharCode(10) + '      endpoint: https://ro-staging.internal' + String.fromCharCode(10) + '    rw:' + String.fromCharCode(10) + '      endpoint: https://rw-staging.internal' + String.fromCharCode(10))
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'staging'))
    // prod has no grant → ro; staging has a grant → rw.
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    expect((await opsAccess.resolve('test', 'staging', SESSION_A)).fields.endpoint).toBe('https://rw-staging.internal')
  })

  it('grant for a different kind does not elevate', async () => {
    const { opsAccess, gate, writeRegistry } = setup()
    writeRegistry(REGISTRY)
    gate.authorize(futureGrant(SESSION_A.id, 'other', 'prod'))
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
  })
})

// ── Session isolation ────────────────────────────────────────────────────────

describe('session isolation', () => {
  it('a grant for session A is invisible to session B', async () => {
    const { opsAccess, gate, writeRegistry } = setup()
    writeRegistry(REGISTRY)
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://rw-prod.internal')
    expect((await opsAccess.resolve('test', 'prod', SESSION_B)).fields.endpoint).toBe('https://ro-prod.internal')
  })

  it('isAuthorized is session-scoped', () => {
    const { gate } = setup()
    gate.authorize(futureGrant('sess-a', 'k8s', 'prod'))
    expect(gate.isAuthorized('sess-a', 'k8s', 'prod')).toBe(true)
    expect(gate.isAuthorized('sess-b', 'k8s', 'prod')).toBe(false)
    expect(gate.isAuthorized('sess-a', 'k8s', 'staging')).toBe(false)
    expect(gate.isAuthorized('sess-a', 'ceph', 'prod')).toBe(false)
  })

  it('re-authorizing the same session+profile replaces the grant', () => {
    const { gate } = setup()
    gate.authorize({ ...futureGrant('s', 'k8s', 'prod'), reason: 'first' })
    gate.authorize({ ...futureGrant('s', 'k8s', 'prod'), reason: 'second' })
    expect(gate.list('s')).toHaveLength(1)
    expect(gate.list('s')[0].reason).toBe('second')
  })
})

// ── Fail-closed ──────────────────────────────────────────────────────────────

describe('fail-closed', () => {
  it('missing agent → ro, even when a grant exists for some session', async () => {
    const { opsAccess, gate, writeRegistry } = setup()
    writeRegistry(REGISTRY)
    // A grant exists, but without an agent there is no session to key it on —
    // rw must never be issued. The ruling comes from the broker (core consults
    // it with agent undefined), not from core short-circuiting.
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    const profile = await opsAccess.resolve('test', 'prod')
    expect(profile.fields.endpoint).toBe('https://ro-prod.internal')
  })

  it('missing agent → approval-required kinds (ssh) deny outright — their credential is effectively rw', async () => {
    const { opsAccess, writeRegistry } = setup()
    writeRegistry(REGISTRY + SSH_REGISTRY)
    const err = await opsAccess.resolve('ssh', 'box').catch((e) => e)
    expect(err.message).toContain('access denied for ssh/box')
    expect(err.message).toContain('request_access')
  })

  it('the grant contract carries no credential fields', () => {
    // Structural guarantee: session/kind/name/expiry/reason/approver only.
    // There is no field on the contract for secret material to ride on.
    const grant = futureGrant('s', 'k8s', 'prod')
    expect(Object.keys(grant).sort()).toEqual(['approvedBy', 'expiresAt', 'kind', 'name', 'reason', 'session'])
  })
})

// ── rw tier errors do not leak secrets ───────────────────────────────────────

describe('rw tier errors', () => {
  it('an authorized resolve with no rw tier errors rather than silently serving ro', async () => {
    const { opsAccess, gate, writeRegistry } = setup()
    writeRegistry('version: 1' + NL + 'test:' + NL + '  prod:' + NL + '    environment: prod' + NL + '    ro:' + NL + '      endpoint: https://ro-prod.internal' + NL)
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    await expect(opsAccess.resolve('test', 'prod', SESSION_A)).rejects.toThrow(/no rw tier/)
  })

  it('the no-rw-tier error does not leak a secret rw value from another profile', async () => {
    const { opsAccess, gate, writeRegistry } = setup()
    writeRegistry('version: 1' + NL + 'test:' + NL + '  prod:' + NL + '    environment: prod' + NL + '    ro:' + NL + '      endpoint: https://ro-prod.internal' + NL + '  other:' + NL + '    rw:' + NL + '      endpoint: https://secret-rw-value.internal' + NL)
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    const err = await opsAccess.resolve('test', 'prod', SESSION_A).catch((e) => e)
    expect(err.message).toContain('no rw tier')
    expect(err.message).not.toContain('secret-rw-value')
  })
})

const NL = String.fromCharCode(10)

// ── request_access: request flow through the pending-request queue ───────────

describe('request_access', () => {
  it('registers the request_access tool and the /access panel command', () => {
    const { tools, commands } = setup()
    expect(tools.map((t) => t.name)).toContain('request_access')
    expect(commands.map((c) => c.name)).toContain('access')
  })

  it('approved request → grant written with the human-chosen TTL, resolve serves rw, audited', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    const { result, decide } = await requestAndDecide(
      h,
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod', ttlMinutes: 45 },
      { agent: SESSION_A, callId: 'call-1' },
      // The human dials the requested 45 min down to a 30-min option.
      { approved: true, ttlMinutes: 30 },
    )
    expect(decide.status).toBe(200)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('30 min')
    expect(result.message).toContain('adjusted')
    expect(result.message).toContain('45 min')
    // The grant works: resolve now serves rw.
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://rw-prod.internal')
    // …but only for this session.
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_B)).fields.endpoint).toBe('https://ro-prod.internal')
    const audit = h.readAudit()
    const requests = audit.filter((l) => l.event === 'grant-request')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ session: 'sess-a', kind: 'test', name: 'prod', reason: 'restart the broken pod', requestedTtlMinutes: 45 })
    const decisions = audit.filter((l) => l.event === 'request-decide')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ outcome: 'approved', ttlMinutes: 30 })
    const grants = audit.filter((l) => l.event === 'grant')
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ approvedBy: 'user', ttlMinutes: 30, requestedTtlMinutes: 45 })
  })

  it('rejected request → no grant, resolve stays ro, decision audited', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    const { result } = await requestAndDecide(
      h,
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod' },
      { agent: SESSION_A },
      { approved: false },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('rejected by the operator')
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    expect(h.readAudit().filter((l) => l.event === 'grant')).toHaveLength(0)
    expect(h.readAudit().filter((l) => l.event === 'request-decide')[0]).toMatchObject({ outcome: 'rejected' })
  })

  it('unanswered request auto-rejects at the configured timeout', async () => {
    const h = setup({ config: { pendingRequestTimeoutMinutes: 0.002 } })
    h.writeRegistry(REGISTRY)
    const call = h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'x' },
      { agent: SESSION_A },
    )
    const req = await awaitPending(h, 'sess-a')
    expect(req.requestedTtlMinutes).toBe(30)
    const result = await call
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no operator decision')
    expect(h.readAudit().filter((l) => l.event === 'request-decide')[0]).toMatchObject({ outcome: 'timeout' })
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
  })

  it('aborted tool call settles the request as cancelled', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    const controller = new AbortController()
    const call = h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'x' },
      { agent: SESSION_A, signal: controller.signal },
    )
    await awaitPending(h, 'sess-a')
    controller.abort()
    const result = await call
    expect(result.ok).toBe(false)
    expect(result.message).toContain('cancelled')
    expect(h.readAudit().filter((l) => l.event === 'request-decide')[0]).toMatchObject({ outcome: 'cancelled' })
  })

  it('deciding an unknown request id 404s', async () => {
    const h = setup()
    const res = await h.callRoute('/ops-access/access-requests/decide', {
      method: 'POST',
      body: { id: 'gr-ghost', approved: true, ttlMinutes: 10 },
    })
    expect(res.status).toBe(404)
  })

  it('approving with a TTL outside the configured options 400s and the request stays parked', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    const call = h.callRequestAccess({ action: 'request', profile: 'test/prod', reason: 'x' }, { agent: SESSION_A })
    const req = await awaitPending(h, 'sess-a')
    const bad = await h.callRoute('/ops-access/access-requests/decide', {
      method: 'POST',
      body: { id: req.id, approved: true, ttlMinutes: 7 },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toContain('5, 10, 30')
    // Still parked — a valid decision settles it.
    const good = await h.callRoute('/ops-access/access-requests/decide', {
      method: 'POST',
      body: { id: req.id, approved: true, ttlMinutes: 10 },
    })
    expect(good.status).toBe(200)
    const result = await call
    expect(result.ok).toBe(true)
    expect(result.message).toContain('10 min')
  })

  it('headless deployment (no web server) → fast clear error, nothing parked', async () => {
    const h = setup({ headless: true })
    h.writeRegistry(REGISTRY)
    const result = await h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod' },
      { agent: SESSION_A },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No approval channel')
    expect(result.message).toContain('headless')
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
    expect(h.readAudit().filter((l) => l.event === 'grant-request')).toHaveLength(0)
  })

  it('missing agent → fail-closed error', async () => {
    const h = setup()
    const result = await h.callRequestAccess({ action: 'request', profile: 'test/prod', reason: 'x' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('requires a session context')
  })

  it('malformed profile string → error, never parked', async () => {
    const h = setup()
    const result = await h.callRequestAccess({ action: 'request', profile: 'noprofile', reason: 'x' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('kind/name')
    expect(h.readAudit().filter((l) => l.event === 'grant-request')).toHaveLength(0)
  })

  it('unknown profile → refused BEFORE parking, pointing at list_access', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    const result = await h.callRequestAccess({ action: 'request', profile: 'test/ghost', reason: 'x' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('test/ghost')
    expect(result.message).toContain('list_access')
    expect(h.readAudit().filter((l) => l.event === 'grant-request')).toHaveLength(0)
  })

  it('empty reason → error', async () => {
    const h = setup()
    const result = await h.callRequestAccess({ action: 'request', profile: 'test/prod', reason: '   ' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('reason')
  })

  it('requested ttl is clamped to the configured maximum before parking', async () => {
    const h = setup({ config: { maxTtlMinutes: 60 } })
    h.writeRegistry(REGISTRY)
    const call = h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'long maintenance', ttlMinutes: 99999 },
      { agent: SESSION_A },
    )
    const req = await awaitPending(h, 'sess-a')
    expect(req.requestedTtlMinutes).toBe(60)
    await h.callRoute('/ops-access/access-requests/decide', { method: 'POST', body: { id: req.id, approved: true, ttlMinutes: 30 } })
    const result = await call
    expect(result.ok).toBe(true)
    expect(result.message).toContain('30 min')
  })

  it('profile without an rw tier is refused BEFORE parking (no undeliverable grants)', async () => {
    const h = setup()
    h.writeRegistry('version: 1' + NL + 'test:' + NL + '  prod:' + NL + '    environment: prod' + NL + '    ro:' + NL + '      endpoint: https://ro-prod.internal' + NL + '  other:' + NL + '    rw:' + NL + '      endpoint: https://rw-other.internal' + NL)
    const result = await h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod' },
      { agent: SESSION_A },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no usable rw tier registered')
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
  })

  it('rw entry that exists but fails schema validation is refused BEFORE parking', async () => {
    const h = setup()
    h.writeRegistry('version: 1' + NL + 'test:' + NL + '  prod:' + NL + '    environment: prod' + NL + '    ro:' + NL + '      endpoint: https://ro-prod.internal' + NL + '    rw:' + NL + '      endpoint: 5' + NL)
    const result = await h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod' },
      { agent: SESSION_A },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no usable rw tier registered')
  })

  it('rw-only profile (ro not yet registered) IS requestable — the derivation bootstrap', async () => {
    const h = setup()
    h.writeRegistry('version: 1' + NL + 'test:' + NL + '  prod:' + NL + '    environment: prod' + NL + '    rw:' + NL + '      endpoint: https://rw-prod.internal' + NL)
    const { result } = await requestAndDecide(
      h,
      { action: 'request', profile: 'test/prod', reason: 'derive a read-only credential and register the ro tier' },
      { agent: SESSION_A },
      { approved: true, ttlMinutes: 30 },
    )
    expect(result.ok).toBe(true)
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(true)
  })

  it('approval-required kinds (ssh) are exempt from the rw-tier check — their credential lives in the ro tier', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY + SSH_REGISTRY)
    const { result } = await requestAndDecide(
      h,
      { action: 'request', profile: 'ssh/box', reason: 'check disk' },
      { agent: SESSION_A },
      { approved: true, ttlMinutes: 5 },
    )
    expect(result.ok).toBe(true)
    expect(h.gate.isAuthorized('sess-a', 'ssh', 'box')).toBe(true)
  })
})

// ── request_access: list + revoke ────────────────────────────────────────────

describe('list and revoke', () => {
  it('list with no grants says so', async () => {
    const h = setup()
    const result = await h.callRequestAccess({ action: 'list' }, { agent: SESSION_A })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('No active grants')
  })

  it('list shows this session’s grants with remaining time', async () => {
    const h = setup()
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    h.gate.authorize(futureGrant('sess-b', 'test', 'prod'))
    const result = await h.callRequestAccess({ action: 'list' }, { agent: SESSION_A })
    expect(result.message).toContain('test/prod')
    expect(result.message).toContain('min left')
    // Session B's grant is not listed under A.
    expect(result.message.match(/test\/prod/g)).toHaveLength(1)
  })

  it('revoke drops the grant immediately and audits it with the agent source', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    const result = await h.callRequestAccess({ action: 'revoke', profile: 'test/prod' }, { agent: SESSION_A })
    expect(result.ok).toBe(true)
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    const revokes = h.readAudit().filter((l) => l.event === 'revoke')
    expect(revokes).toHaveLength(1)
    expect(revokes[0]).toMatchObject({ source: 'agent' })
  })

  it('revoke of a nonexistent grant reports it', async () => {
    const h = setup()
    const result = await h.callRequestAccess({ action: 'revoke', profile: 'test/prod' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No active grant')
  })
})

// ── Panel routes: proactive grants and revokes ───────────────────────────────

describe('panel routes', () => {
  it('GET /ops-access/grants lists the session grants with remaining minutes', async () => {
    const h = setup()
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    const res = await h.callRoute('/ops-access/grants', { query: '?session=sess-a' })
    expect(res.status).toBe(200)
    expect(res.json.grants).toHaveLength(1)
    expect(res.json.grants[0]).toMatchObject({ kind: 'test', name: 'prod', remainingMinutes: 30 })
    const other = await h.callRoute('/ops-access/grants', { query: '?session=sess-b' })
    expect(other.json.grants).toHaveLength(0)
  })

  it('POST /ops-access/grants writes a panel grant, audits it, and queues a notice', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    const res = await h.callRoute('/ops-access/grants', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod', ttlMinutes: 10 },
    })
    expect(res.status).toBe(200)
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(true)
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://rw-prod.internal')
    const grants = h.readAudit().filter((l) => l.event === 'grant')
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ approvedBy: 'panel', ttlMinutes: 10, reason: 'operator panel grant' })
    // The agent gets told at the next pre-step.
    const injected = await drainNotices(h, 'sess-a')
    expect(injected.join(' ')).toContain('<access-grant>')
    expect(injected.join(' ')).toContain('test/prod')
    // Drained once — a second pre-step injects nothing.
    expect((await drainNotices(h, 'sess-a'))).toHaveLength(0)
  })

  it('POST /ops-access/grants rejects a TTL outside the configured options', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    const res = await h.callRoute('/ops-access/grants', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod', ttlMinutes: 12 },
    })
    expect(res.status).toBe(400)
    expect(res.json.error).toContain('5, 10, 30')
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
  })

  it('POST /ops-access/grants rejects an undeliverable profile', async () => {
    const h = setup()
    h.writeRegistry('version: 1' + NL + 'test:' + NL + '  prod:' + NL + '    ro:' + NL + '      endpoint: https://ro-prod.internal' + NL)
    const res = await h.callRoute('/ops-access/grants', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod', ttlMinutes: 10 },
    })
    expect(res.status).toBe(400)
    expect(res.json.error).toContain('no usable rw tier')
  })

  it('POST /ops-access/grants/revoke drops one grant, audits panel source, notifies', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    const res = await h.callRoute('/ops-access/grants/revoke', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod' },
    })
    expect(res.status).toBe(200)
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
    const revokes = h.readAudit().filter((l) => l.event === 'revoke')
    expect(revokes).toHaveLength(1)
    expect(revokes[0]).toMatchObject({ source: 'panel', kind: 'test', name: 'prod' })
    const injected = await drainNotices(h, 'sess-a')
    expect(injected.join(' ')).toContain('<access-revoked>')
  })

  it('POST /ops-access/grants/revoke of a nonexistent grant 400s', async () => {
    const h = setup()
    const res = await h.callRoute('/ops-access/grants/revoke', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod' },
    })
    expect(res.status).toBe(400)
  })

  it('POST /ops-access/grants/extend renews an active grant from now, audits grant-extend, notifies', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod')) // expires in 30 min
    const before = Date.now()
    const res = await h.callRoute('/ops-access/grants/extend', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod', ttlMinutes: 30 },
    })
    expect(res.status).toBe(200)
    // renewed from NOW + 30min — never accumulated on top of the old expiry
    expect(res.json.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60000)
    expect(res.json.expiresAt).toBeLessThan(Date.now() + 31 * 60000)
    expect(h.gate.list('sess-a')[0].expiresAt).toBe(res.json.expiresAt)
    // original reason/approvedBy are preserved
    expect(h.gate.list('sess-a')[0]).toMatchObject({ reason: 'test reason', approvedBy: 'user' })
    const extends_ = h.readAudit().filter((l) => l.event === 'grant-extend')
    expect(extends_).toHaveLength(1)
    expect(extends_[0]).toMatchObject({ kind: 'test', name: 'prod', ttlMinutes: 30 })
    expect(typeof extends_[0].previousExpiresAt).toBe('number')
    const injected = await drainNotices(h, 'sess-a')
    expect(injected.join(' ')).toContain('<access-grant>')
    expect(injected.join(' ')).toContain('延长')
  })

  it('POST /ops-access/grants/extend rejects a nonexistent grant (expired grants are filtered from list, same path)', async () => {
    const h = setup()
    const res = await h.callRoute('/ops-access/grants/extend', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod', ttlMinutes: 30 },
    })
    expect(res.status).toBe(400)
    expect(res.json.error).toContain('no active grant')
    expect(h.readAudit().filter((l) => l.event === 'grant-extend')).toHaveLength(0)
  })

  it('POST /ops-access/grants/extend rejects a TTL outside the configured options', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    const res = await h.callRoute('/ops-access/grants/extend', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'test', name: 'prod', ttlMinutes: 45 },
    })
    expect(res.status).toBe(400)
    expect(res.json.error).toContain('5, 10, 30')
  })

  it('POST /ops-access/grants/revoke-all clears the session and audits each revoke', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY + SSH_REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    h.gate.authorize(futureGrant('sess-a', 'ssh', 'box'))
    h.gate.authorize(futureGrant('sess-b', 'test', 'prod'))
    const res = await h.callRoute('/ops-access/grants/revoke-all', {
      method: 'POST',
      body: { session: 'sess-a' },
    })
    expect(res.status).toBe(200)
    expect(res.json.revoked).toBe(2)
    expect(h.gate.list('sess-a')).toHaveLength(0)
    // Session B is untouched.
    expect(h.gate.list('sess-b')).toHaveLength(1)
    expect(h.readAudit().filter((l) => l.event === 'revoke')).toHaveLength(2)
    const injected = await drainNotices(h, 'sess-a')
    expect(injected.join(' ')).toContain('全部提权授权（2 项）')
  })

  it('revoke notices survive ledger eviction semantics: revoke takes effect on the NEXT resolve', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    await h.callRoute('/ops-access/grants/revoke', { method: 'POST', body: { session: 'sess-a', kind: 'test', name: 'prod' } })
    // The broker re-reads the ledger on every resolve — the next call is ro.
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
  })
})

// ── TTL expiry ───────────────────────────────────────────────────────────────

describe('ttl expiry', () => {
  it('an expired grant lapses to ro and is audited exactly once', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    h.gate.authorize({ session: 'sess-a', kind: 'test', name: 'prod', expiresAt: Date.now() - 1000, reason: 'old', approvedBy: 'user' })
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    expect(h.readAudit().filter((l) => l.event === 'expire')).toHaveLength(1)
    // The lapsed grant was evicted — a second consult does not re-audit.
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
    expect(h.readAudit().filter((l) => l.event === 'expire')).toHaveLength(1)
  })
})

// ── Approval-required kinds (ssh) ────────────────────────────────────────────

describe('approval-required kinds', () => {
  it('ssh without a grant → deny pointing at request_access', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY + SSH_REGISTRY)
    const err = await h.opsAccess.resolve('ssh', 'box', SESSION_A).catch((e) => e)
    expect(err.message).toContain('request_access')
  })

  it('ssh with a grant → served from the ro tier, gated-issue audited', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY + SSH_REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'ssh', 'box'))
    const profile = await h.opsAccess.resolve('ssh', 'box', SESSION_A)
    expect(profile.fields.host).toBe('10.0.0.1')
    const lines = h.readAudit().filter((l) => l.event === 'gated-issue')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ session: 'sess-a', kind: 'ssh', name: 'box' })
  })

  it('a panel grant for ssh is a timed pass to use it at all', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY + SSH_REGISTRY)
    const res = await h.callRoute('/ops-access/grants', {
      method: 'POST',
      body: { session: 'sess-a', kind: 'ssh', name: 'box', ttlMinutes: 5 },
    })
    expect(res.status).toBe(200)
    const profile = await h.opsAccess.resolve('ssh', 'box', SESSION_A)
    expect(profile.fields.host).toBe('10.0.0.1')
    const injected = await drainNotices(h, 'sess-a')
    expect(injected.join(' ')).toContain('限时使用权限')
  })
})

// ── Audit log ────────────────────────────────────────────────────────────────

describe('audit log', () => {
  it('apply writes a ledger-reset line — boot and HMR reload both start an empty ledger', () => {
    const h = setup()
    const lines = h.readAudit().filter((l) => l.event === 'ledger-reset')
    expect(lines).toHaveLength(1)
    expect(typeof lines[0].ts).toBe('string')
  })

  it('every rw issue is audited', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    await h.opsAccess.resolve('test', 'prod', SESSION_A)
    await h.opsAccess.resolve('test', 'prod', SESSION_A)
    const lines = h.readAudit().filter((l) => l.event === 'rw-issue')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ session: 'sess-a', kind: 'test', name: 'prod' })
  })

  it('ro resolves are not audited', async () => {
    const h = setup()
    h.writeRegistry(REGISTRY)
    await h.opsAccess.resolve('test', 'prod', SESSION_A)
    // ledger-reset (from apply) is the only line; the ro resolve added nothing.
    expect(h.readAudit().filter((l) => l.event !== 'ledger-reset')).toHaveLength(0)
  })
})

// ── Deferred mounting (cordis inject semantics) ─────────────────────────────

describe('deferred mounting', () => {
  it('gate-first mounting still lands the broker in core', async () => {
    const h = setup({ gateFirst: true })
    h.writeRegistry(REGISTRY)
    // If registerAccessBroker's deferred inject never fired, this resolve would
    // serve ro despite the grant — the broker would silently not exist.
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://rw-prod.internal')
    expect(h.tools.map((t) => t.name)).toContain('request_access')
  })
})
