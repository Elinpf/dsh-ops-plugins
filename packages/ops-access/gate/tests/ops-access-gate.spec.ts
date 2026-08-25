/**
 * Unit spec for ops-access-gate: mounts core + gate together and drives the
 * externally observable seam — resolve serves ro vs rw fields depending on
 * the ledger, grants are isolated by session, a missing agent is fail-closed,
 * request_access flows through the (mocked) approval channel, TTL expiry and
 * revoke behave, ssh is gated per-use, and every transition lands in the
 * audit log. The gate never touches credential fields.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { setup, RO_REGISTRY, RW_REGISTRY, SSH_REGISTRY } from './harness.ts'

const SESSION_A = { id: 'sess-a' }
const SESSION_B = { id: 'sess-b' }

/** A grant that expires 30 minutes from now. */
function futureGrant(session: string, kind: string, name: string): plugin.Grant {
  return { session, kind, name, expiresAt: Date.now() + 30 * 60000, reason: 'test reason', approvedBy: 'user' }
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
  it('no grant → ro fields served from the ro registry', async () => {
    const { opsAccess, writeRo, writeRw } = setup()
    writeRo(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    const profile = await opsAccess.resolve('test', 'prod', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://ro-prod.internal')
  })

  it('grant for the session → rw fields served from the rw registry', async () => {
    const { opsAccess, gate, writeRo, writeRw } = setup()
    writeRo(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    const profile = await opsAccess.resolve('test', 'prod', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://rw-prod.internal')
  })

  it('grant for a different profile does not elevate the requested one', async () => {
    const { opsAccess, gate, writeRo, writeRw } = setup()
    writeRo(RO_REGISTRY + '  staging:\n    endpoint: https://ro-staging.internal\n')
    writeRw(RW_REGISTRY + '  staging:\n    endpoint: https://rw-staging.internal\n')
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'staging'))
    // prod has no grant → ro; staging has a grant → rw.
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    expect((await opsAccess.resolve('test', 'staging', SESSION_A)).fields.endpoint).toBe('https://rw-staging.internal')
  })

  it('grant for a different kind does not elevate', async () => {
    const { opsAccess, gate, writeRo } = setup()
    writeRo(RO_REGISTRY)
    gate.authorize(futureGrant(SESSION_A.id, 'other', 'prod'))
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
  })
})

// ── Session isolation ────────────────────────────────────────────────────────

describe('session isolation', () => {
  it('a grant for session A is invisible to session B', async () => {
    const { opsAccess, gate, writeRo, writeRw } = setup()
    writeRo(RO_REGISTRY)
    writeRw(RW_REGISTRY)
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
    const { opsAccess, gate, writeRo, writeRw } = setup()
    writeRo(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    // A grant exists, but without an agent there is no session to key it on —
    // rw must never be issued. This is the system-internal-call case.
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    const profile = await opsAccess.resolve('test', 'prod')
    expect(profile.fields.endpoint).toBe('https://ro-prod.internal')
  })

  it('the grant contract carries no credential fields', () => {
    // Structural guarantee: session/kind/name/expiry/reason/approver only.
    // There is no field on the contract for secret material to ride on.
    const grant = futureGrant('s', 'k8s', 'prod')
    expect(Object.keys(grant).sort()).toEqual(['approvedBy', 'expiresAt', 'kind', 'name', 'reason', 'session'])
  })
})

// ── rw file errors do not leak secrets ───────────────────────────────────────

describe('rw file errors', () => {
  it('rw file missing on an authorized resolve errors with the rw file path', async () => {
    const { opsAccess, gate, writeRo, rwFile } = setup()
    writeRo(RO_REGISTRY)
    // rw file deliberately absent
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    await expect(opsAccess.resolve('test', 'prod', SESSION_A)).rejects.toThrow(`registry file not found: ${rwFile}`)
  })

  it('rw entry missing errors without leaking the rw field value', async () => {
    const { opsAccess, gate, writeRo, writeRw, rwFile } = setup()
    writeRo(RO_REGISTRY)
    writeRw('test:\n  other:\n    endpoint: https://secret-rw-value.internal\n')
    gate.authorize(futureGrant(SESSION_A.id, 'test', 'prod'))
    const err = await opsAccess.resolve('test', 'prod', SESSION_A).catch((e) => e)
    expect(err.message).toContain(rwFile)
    expect(err.message).not.toContain('secret-rw-value')
  })
})

// ── request_access: request flow ─────────────────────────────────────────────

describe('request_access', () => {
  it('registers the request_access tool', () => {
    const { tools } = setup()
    expect(tools.map((t) => t.name)).toContain('request_access')
  })

  it('approved request → grant written, resolve serves rw, grant audited', async () => {
    const h = setup({ approvalOutcome: 'allowed-once' })
    h.writeRo(RO_REGISTRY)
    h.writeRw(RW_REGISTRY)
    const result = await h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod', ttlMinutes: 45 },
      { agent: SESSION_A, callId: 'call-1' },
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('45 min')
    // The human saw the profile, the ttl, and the verbatim reason.
    expect(h.approvalRequests).toHaveLength(1)
    expect(h.approvalRequests[0].reason).toContain('test/prod')
    expect(h.approvalRequests[0].reason).toContain('45 min')
    expect(h.approvalRequests[0].reason).toContain('restart the broken pod')
    // The grant works: resolve now serves rw.
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://rw-prod.internal')
    // …but only for this session.
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_B)).fields.endpoint).toBe('https://ro-prod.internal')
    const grantLines = h.readAudit().filter((l) => l.event === 'grant')
    expect(grantLines).toHaveLength(1)
    expect(grantLines[0]).toMatchObject({ session: 'sess-a', kind: 'test', name: 'prod', reason: 'restart the broken pod', approvedBy: 'user' })
    expect(typeof grantLines[0].ts).toBe('string')
  })

  it('rejected request → no grant, resolve stays ro', async () => {
    const h = setup({ approvalOutcome: 'rejected' })
    h.writeRo(RO_REGISTRY)
    h.writeRw(RW_REGISTRY)
    const result = await h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod' },
      { agent: SESSION_A },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('rejected')
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    expect(h.readAudit().filter((l) => l.event === 'grant')).toHaveLength(0)
  })

  it('no approval channel → clear error, no grant', async () => {
    const h = setup()
    h.writeRo(RO_REGISTRY)
    const result = await h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'restart the broken pod' },
      { agent: SESSION_A },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('approval channel')
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
  })

  it('missing agent → fail-closed error', async () => {
    const h = setup({ approvalOutcome: 'allowed-once' })
    const result = await h.callRequestAccess({ action: 'request', profile: 'test/prod', reason: 'x' })
    expect(result.ok).toBe(false)
    expect(h.approvalRequests).toHaveLength(0)
  })

  it('malformed profile string → error, approval never consulted', async () => {
    const h = setup({ approvalOutcome: 'allowed-once' })
    const result = await h.callRequestAccess({ action: 'request', profile: 'noprofile', reason: 'x' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('kind/name')
    expect(h.approvalRequests).toHaveLength(0)
  })

  it('unknown profile → resolve error verbatim, approval never consulted', async () => {
    const h = setup({ approvalOutcome: 'allowed-once' })
    h.writeRo(RO_REGISTRY)
    const result = await h.callRequestAccess({ action: 'request', profile: 'test/ghost', reason: 'x' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no profile "ghost"')
    expect(h.approvalRequests).toHaveLength(0)
  })

  it('empty reason → error', async () => {
    const h = setup({ approvalOutcome: 'allowed-once' })
    const result = await h.callRequestAccess({ action: 'request', profile: 'test/prod', reason: '   ' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('reason')
  })

  it('ttl is clamped to the configured maximum', async () => {
    const h = setup({ approvalOutcome: 'allowed-once', config: { maxTtlMinutes: 60 } })
    h.writeRo(RO_REGISTRY)
    const before = Date.now()
    const result = await h.callRequestAccess(
      { action: 'request', profile: 'test/prod', reason: 'long maintenance', ttlMinutes: 99999 },
      { agent: SESSION_A },
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('60 min')
    const grants = h.gate.list('sess-a')
    expect(grants).toHaveLength(1)
    expect(grants[0].expiresAt).toBeGreaterThanOrEqual(before + 60 * 60000)
    expect(grants[0].expiresAt).toBeLessThan(Date.now() + 61 * 60000)
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

  it('revoke drops the grant immediately and audits it', async () => {
    const h = setup()
    h.writeRo(RO_REGISTRY)
    h.writeRw(RW_REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    const result = await h.callRequestAccess({ action: 'revoke', profile: 'test/prod' }, { agent: SESSION_A })
    expect(result.ok).toBe(true)
    expect(h.gate.isAuthorized('sess-a', 'test', 'prod')).toBe(false)
    expect((await h.opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    expect(h.readAudit().filter((l) => l.event === 'revoke')).toHaveLength(1)
  })

  it('revoke of a nonexistent grant reports it', async () => {
    const h = setup()
    const result = await h.callRequestAccess({ action: 'revoke', profile: 'test/prod' }, { agent: SESSION_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No active grant')
  })
})

// ── TTL expiry ───────────────────────────────────────────────────────────────

describe('ttl expiry', () => {
  it('an expired grant lapses to ro and is audited exactly once', async () => {
    const h = setup()
    h.writeRo(RO_REGISTRY)
    h.writeRw(RW_REGISTRY)
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
    h.writeRo(RO_REGISTRY + SSH_REGISTRY)
    const err = await h.opsAccess.resolve('ssh', 'box', SESSION_A).catch((e) => e)
    expect(err.message).toContain('request_access')
  })

  it('ssh with a grant → served from the ro registry, gated-issue audited', async () => {
    const h = setup()
    h.writeRo(RO_REGISTRY + SSH_REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'ssh', 'box'))
    const profile = await h.opsAccess.resolve('ssh', 'box', SESSION_A)
    expect(profile.fields.host).toBe('10.0.0.1')
    const lines = h.readAudit().filter((l) => l.event === 'gated-issue')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ session: 'sess-a', kind: 'ssh', name: 'box' })
  })
})

// ── Audit log ────────────────────────────────────────────────────────────────

describe('audit log', () => {
  it('every rw issue is audited', async () => {
    const h = setup()
    h.writeRo(RO_REGISTRY)
    h.writeRw(RW_REGISTRY)
    h.gate.authorize(futureGrant('sess-a', 'test', 'prod'))
    await h.opsAccess.resolve('test', 'prod', SESSION_A)
    await h.opsAccess.resolve('test', 'prod', SESSION_A)
    const lines = h.readAudit().filter((l) => l.event === 'rw-issue')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ session: 'sess-a', kind: 'test', name: 'prod' })
  })

  it('ro resolves are not audited', async () => {
    const h = setup()
    h.writeRo(RO_REGISTRY)
    await h.opsAccess.resolve('test', 'prod', SESSION_A)
    expect(h.readAudit()).toHaveLength(0)
  })
})
