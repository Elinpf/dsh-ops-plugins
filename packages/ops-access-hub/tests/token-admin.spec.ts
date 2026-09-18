/**
 * Spec for fine-grained token administration (ADR-0010), driven at all three
 * levels.
 *
 * Pure layer: the roster status classification (active / expiring / expired /
 * revoked, including the boundary and a corrupt `expiresAt`) and the patch
 * parser that keeps "absent" distinct from "clear".
 *
 * Store layer: `updateToken` — which fields actually changed, label-clash
 * refusal, revoked records being terminal, unknown ids, and the persisted
 * result after a reload.
 *
 * HTTP layer: `PATCH /tokens/:id` — the edit round-trip, role changes taking
 * effect on the next request, renewal of an expired token and clearing of an
 * expiry, the no-op patch writing nothing, validation/auth errors, and the
 * audit line carrying the actor plus the touched field names.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubStore } from '../src/store.ts'
import { createHubServer } from '../src/server.ts'
import { EXPIRING_SOON_MS, hashToken, parseExpiresAtPatch, tokenStatus } from '../src/tokens.ts'
import { mktmpdir } from '@elinpf/dsh-ops-test-support/tmpdir'

const ADMIN = 'test-admin-token'
const READ = 'test-read-token'

describe('token status classification', () => {
  const now = new Date('2026-06-01T00:00:00.000Z')

  it('is active without an expiry and revoked once revoked', () => {
    expect(tokenStatus({}, now)).toBe('active')
    expect(tokenStatus({ expiresAt: '2030-01-01T00:00:00.000Z' }, now)).toBe('active')
    expect(tokenStatus({ revokedAt: '2026-05-01T00:00:00.000Z' }, now)).toBe('revoked')
    // Revocation outranks a still-distant expiry.
    expect(tokenStatus({ revokedAt: '2026-05-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' }, now)).toBe('revoked')
  })

  it('splits expiring from active at the seven-day boundary', () => {
    const justInside = new Date(now.getTime() + EXPIRING_SOON_MS).toISOString()
    const justOutside = new Date(now.getTime() + EXPIRING_SOON_MS + 1).toISOString()
    expect(tokenStatus({ expiresAt: justInside }, now)).toBe('expiring')
    expect(tokenStatus({ expiresAt: justOutside }, now)).toBe('active')
  })

  it('treats a past or unparseable expiry as expired rather than active', () => {
    expect(tokenStatus({ expiresAt: '2026-05-31T23:59:59.999Z' }, now)).toBe('expired')
    // Expiry is inclusive: the token dies at its own timestamp.
    expect(tokenStatus({ expiresAt: now.toISOString() }, now)).toBe('expired')
    expect(tokenStatus({ expiresAt: 'not-a-date' }, now)).toBe('expired')
  })

  it('keeps "absent" (keep) distinct from "clear" in the patch parser', () => {
    expect(parseExpiresAtPatch(undefined)).toBeUndefined()
    expect(parseExpiresAtPatch(null)).toBeNull()
    expect(parseExpiresAtPatch('')).toBeNull()
    expect(parseExpiresAtPatch('2030-01-01T00:00:00Z')).toBe('2030-01-01T00:00:00.000Z')
    expect(() => parseExpiresAtPatch('2020-01-01T00:00:00Z')).toThrow(/future/)
    expect(() => parseExpiresAtPatch(42)).toThrow(/ISO date/)
  })
})

describe('token store updates', () => {
  function fresh(): { store: HubStore; dir: string } {
    const dir = mktmpdir('hub-token-admin-')
    return { store: new HubStore({ dataDir: dir }), dir }
  }

  it('edits label, role and expiry and reports exactly what changed', async () => {
    const { store, dir } = fresh()
    await store.init()
    const alice = store.putToken({ name: 'alice', role: 'read', hash: hashToken('a'), prefix: 'aaaaaaaa', createdBy: 'admin' })

    const result = store.updateToken(alice.id, { name: 'alice-2', role: 'admin', expiresAt: '2030-01-01T00:00:00.000Z' })!
    expect(result.changes).toEqual(['name', 'role', 'expiresAt'])
    expect(result.token).toMatchObject({ name: 'alice-2', role: 'admin', expiresAt: '2030-01-01T00:00:00.000Z' })
    // The secret is untouched by an edit — same digest, same prefix.
    expect(result.token.hash).toBe(hashToken('a'))
    expect(result.token.prefix).toBe('aaaaaaaa')

    await store.save()
    const reopened = new HubStore({ dataDir: dir })
    await reopened.init()
    expect(reopened.getToken(alice.id)).toMatchObject({ name: 'alice-2', role: 'admin', expiresAt: '2030-01-01T00:00:00.000Z' })
    // The old label is free again, the new one is taken.
    expect(reopened.findTokenByName('alice')).toBeUndefined()
    expect(reopened.findTokenByName('alice-2')?.id).toBe(alice.id)
  })

  it('clears an expiry with null and reports a no-op patch as empty', async () => {
    const { store } = fresh()
    await store.init()
    const alice = store.putToken({
      name: 'alice',
      role: 'read',
      hash: hashToken('a'),
      prefix: 'aaaaaaaa',
      createdBy: 'admin',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })

    expect(store.updateToken(alice.id, { expiresAt: null })!.changes).toEqual(['expiresAt'])
    expect(store.getToken(alice.id)!.expiresAt).toBeUndefined()

    // Re-applying the same values changes nothing (so nothing is written or audited).
    expect(store.updateToken(alice.id, { name: 'alice', role: 'read' })!.changes).toEqual([])
    expect(store.updateToken(alice.id, { expiresAt: undefined })!.changes).toEqual([])
  })

  it('refuses a label another live token holds, but allows its own and a revoked one', async () => {
    const { store } = fresh()
    await store.init()
    const alice = store.putToken({ name: 'alice', role: 'read', hash: hashToken('a'), prefix: 'aaaaaaaa', createdBy: 'admin' })
    const bob = store.putToken({ name: 'bob', role: 'read', hash: hashToken('b'), prefix: 'bbbbbbbb', createdBy: 'admin' })

    expect(() => store.updateToken(alice.id, { name: 'bob' })).toThrow(/already in use/)
    // Renaming to itself is not a clash; renaming onto a revoked label is fine.
    expect(store.updateToken(alice.id, { name: 'alice' })!.changes).toEqual([])
    store.revokeToken(bob.id)
    expect(store.updateToken(alice.id, { name: 'bob' })!.changes).toEqual(['name'])
  })

  it('treats a revoked record as terminal and an unknown id as absent', async () => {
    const { store } = fresh()
    await store.init()
    const alice = store.putToken({ name: 'alice', role: 'read', hash: hashToken('a'), prefix: 'aaaaaaaa', createdBy: 'admin' })
    expect(store.updateToken('missing', { role: 'admin' })).toBeNull()
    store.revokeToken(alice.id)
    expect(() => store.updateToken(alice.id, { role: 'admin' })).toThrow(/revoked/)
    expect(store.getToken(alice.id)!.role).toBe('read')
  })
})

describe('PATCH /tokens/:id', () => {
  let store: HubStore
  let server: Server
  let base: string

  async function api(path: string, opts: { method?: string; token?: string | null; body?: unknown } = {}) {
    const headers: Record<string, string> = {}
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? ADMIN}`
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: res.status, body: body as Record<string, unknown> }
  }

  /** Issue a token over the API and return its id/plaintext pair. */
  async function issue(name: string, role: 'admin' | 'read', extra: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
    const r = await api('/tokens', { method: 'POST', body: { name, role, ...extra } })
    expect(r.status).toBe(200)
    return { id: r.body.id as string, token: r.body.token as string }
  }

  beforeEach(async () => {
    store = new HubStore({ dataDir: mktmpdir('hub-token-patch-') })
    await store.init()
    server = createHubServer({ store, adminToken: ADMIN, readToken: READ })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolveClose) => server.close(resolveClose))
  })

  it('edits a record in place and keeps the holder working with the same secret', async () => {
    const alice = await issue('alice', 'read', { expiresAt: '2030-01-01T00:00:00Z' })

    const r = await api(`/tokens/${alice.id}`, {
      method: 'PATCH',
      body: { name: 'alice-read', role: 'read', expiresAt: '2031-06-01T00:00:00Z' },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, name: 'alice-read', role: 'read', expiresAt: '2031-06-01T00:00:00.000Z' })
    expect(r.body.changes).toEqual(['name', 'expiresAt'])
    expect(r.body.hash).toBeUndefined()
    expect(r.body.prefix).toBe(alice.token.slice(0, 8))

    // Same plaintext, new label — /whoami proves the identity change took.
    expect((await api('/whoami', { token: alice.token })).body).toMatchObject({ role: 'read', actor: 'alice-read', source: 'named' })
    const list = (await api('/tokens')).body as unknown as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'alice-read', expiresAt: '2031-06-01T00:00:00.000Z' })
  })

  it('applies a role change to the very next request', async () => {
    const alice = await issue('alice', 'read')
    expect((await api('/audit', { token: alice.token })).status).toBe(403)

    expect((await api(`/tokens/${alice.id}`, { method: 'PATCH', body: { role: 'admin' } })).status).toBe(200)
    expect((await api('/audit', { token: alice.token })).status).toBe(200)
    expect((await api('/whoami', { token: alice.token })).body).toMatchObject({ role: 'admin', actor: 'alice' })

    expect((await api(`/tokens/${alice.id}`, { method: 'PATCH', body: { role: 'read' } })).status).toBe(200)
    expect((await api('/audit', { token: alice.token })).status).toBe(403)
    // Still authenticated — demotion is not revocation.
    expect((await api('/entries', { token: alice.token })).status).toBe(200)
  })

  it('clears an expiry and renews an expired record', async () => {
    const alice = await issue('alice', 'read', { expiresAt: '2030-01-01T00:00:00Z' })
    expect((await api(`/tokens/${alice.id}`, { method: 'PATCH', body: { expiresAt: null } })).status).toBe(200)
    expect(store.getToken(alice.id)!.expiresAt).toBeUndefined()
    // '' is the form the CLI/HTML input sends for "clear".
    expect((await api(`/tokens/${alice.id}`, { method: 'PATCH', body: { expiresAt: '' } })).body.changes).toEqual([])

    // An already-expired record (written straight to the store) authenticates
    // again once renewed — renewing beats revoke-and-reissue.
    store.putToken({ name: 'expired', role: 'read', hash: hashToken('expired-secret'), prefix: 'expired-', createdBy: 'test', expiresAt: '2000-01-01T00:00:00.000Z' })
    const expiredId = store.findTokenByName('expired')!.id
    expect((await api('/entries', { token: 'expired-secret' })).status).toBe(401)
    expect((await api(`/tokens/${expiredId}`, { method: 'PATCH', body: { expiresAt: '2030-01-01T00:00:00Z' } })).status).toBe(200)
    expect((await api('/entries', { token: 'expired-secret' })).status).toBe(200)
  })

  it('treats a patch that matches the current values as a no-op (no write, no audit line)', async () => {
    const alice = await issue('alice', 'read')
    const before = (await api('/audit')).body as unknown as unknown[]

    const r = await api(`/tokens/${alice.id}`, { method: 'PATCH', body: { name: 'alice', role: 'read' } })
    expect(r.status).toBe(200)
    expect(r.body.changes).toEqual([])
    expect((await api('/audit')).body as unknown as unknown[]).toHaveLength(before.length)
  })

  it('validates the patch body', async () => {
    const alice = await issue('alice', 'read')
    await issue('bob', 'read')

    const cases: Array<[unknown, number, RegExp]> = [
      [{}, 400, /no updatable fields/],
      [{ nickname: 'x' }, 400, /no updatable fields/],
      [{ role: 'owner' }, 400, /role must be/],
      [{ name: 'a/b' }, 400, /invalid name/],
      [{ name: '' }, 400, /invalid name/],
      [{ expiresAt: 'soon' }, 400, /ISO date/],
      [{ expiresAt: '2020-01-01T00:00:00Z' }, 400, /future/],
      [{ name: 'bob' }, 409, /already in use/],
    ]
    for (const [body, status, pattern] of cases) {
      const r = await api(`/tokens/${alice.id}`, { method: 'PATCH', body })
      expect([body, r.status]).toEqual([body, status])
      expect(String(r.body.error)).toMatch(pattern)
    }
    // Nothing above leaked into the record.
    expect(store.getToken(alice.id)).toMatchObject({ name: 'alice', role: 'read' })
  })

  it('refuses unknown, revoked and non-admin patches', async () => {
    const alice = await issue('alice', 'read')
    expect((await api('/tokens/missing', { method: 'PATCH', body: { role: 'admin' } })).status).toBe(404)
    expect((await api(`/tokens/${alice.id}`, { method: 'PATCH', token: READ, body: { role: 'admin' } })).status).toBe(403)
    expect((await api(`/tokens/${alice.id}`, { method: 'PATCH', token: null, body: { role: 'admin' } })).status).toBe(401)

    await api(`/tokens/${alice.id}`, { method: 'DELETE' })
    const revoked = await api(`/tokens/${alice.id}`, { method: 'PATCH', body: { role: 'admin' } })
    expect(revoked.status).toBe(409)
    expect(revoked.body.error).toMatch(/revoked/)
    expect((await api('/tokens', { method: 'PATCH', body: {} })).status).toBe(405)
  })

  it('records the actor and the touched field names, never a value', async () => {
    const alice = await issue('alice', 'read')
    const root = await issue('root', 'admin')
    await api(`/tokens/${alice.id}`, { method: 'PATCH', token: root.token, body: { name: 'alice-2', role: 'admin', expiresAt: '2030-01-01T00:00:00Z' } })
    // A static bootstrap holder is logged with its role only, like every other action it takes.
    await api(`/tokens/${root.id}`, { method: 'PATCH', body: { name: 'root-2' } })

    const records = (await api('/audit')).body as unknown as Array<Record<string, unknown>>
    expect(records.map((r) => r.action)).toEqual(['token-create', 'token-create', 'token-update', 'token-update'])
    expect(records[2]).toMatchObject({
      role: 'admin',
      kind: 'token',
      name: 'alice-2',
      actor: 'root',
      changes: ['name', 'role', 'expiresAt'],
    })
    expect(records[3]).toMatchObject({ name: 'root-2', changes: ['name'] })
    expect(records[3].actor).toBeUndefined()
    expect(JSON.stringify(records)).not.toContain(alice.token)
  })
})
