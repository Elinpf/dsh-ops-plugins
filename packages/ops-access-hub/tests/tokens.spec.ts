/**
 * Spec for named tokens (ADR-0009), driven at both levels.
 *
 * Pure layer: minting/hashing/prefix, label + role + expiry parsing, the
 * active-window rule and the metadata projection.
 *
 * Store layer: persistence across reload, label uniqueness among live tokens,
 * lookup skipping revoked/expired records, terminal revocation, the roster cap.
 *
 * HTTP layer: admin-only issuance, the one-time plaintext, the no-digest
 * listing guarantee, a named token's role enforcement (and its difference
 * from the other holders), revocation/expiry as authentication failures,
 * `createdBy` attribution, `/whoami`, and audit lines carrying the actor.
 */

import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubStore } from '../src/store.ts'
import { createHubServer } from '../src/server.ts'
import {
  generateToken,
  hashEqual,
  hashToken,
  isTokenActive,
  MAX_TOKENS,
  parseExpiresAt,
  parseTokenName,
  parseTokenRole,
  toTokenView,
  tokenPrefix,
  TOKEN_NAME_PATTERN,
} from '../src/tokens.ts'
import { mktmpdir } from '@elinpf/dsh-ops-test-support/tmpdir'

const ADMIN = 'test-admin-token'
const READ = 'test-read-token'

describe('token helpers', () => {
  it('mints url-safe 192-bit tokens that are unique per call', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a).not.toBe(b)
    expect(tokenPrefix(a)).toBe(a.slice(0, 8))
    expect(tokenPrefix(a)).toHaveLength(8)
  })

  it('hashes deterministically to a 64-char hex digest', () => {
    const token = generateToken()
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toBe(hashToken(generateToken()))
  })

  it('compares digests in constant time, rejecting length mismatches', () => {
    expect(hashEqual('ab', 'ab')).toBe(true)
    expect(hashEqual('ab', 'ac')).toBe(false)
    expect(hashEqual('ab', 'abc')).toBe(false)
    expect(hashEqual(hashToken('x'), hashToken('x'))).toBe(true)
  })

  it('applies the active window: revoked and expired tokens are inactive', () => {
    const now = '2026-06-01T00:00:00.000Z'
    expect(isTokenActive({}, now)).toBe(true)
    expect(isTokenActive({ expiresAt: '2026-06-01T00:00:00.001Z' }, now)).toBe(true)
    // Expiry is inclusive: the token dies at its own timestamp.
    expect(isTokenActive({ expiresAt: now }, now)).toBe(false)
    expect(isTokenActive({ expiresAt: '2026-05-31T23:59:59.999Z' }, now)).toBe(false)
    expect(isTokenActive({ revokedAt: now }, now)).toBe(false)
    expect(isTokenActive({ revokedAt: now, expiresAt: '2030-01-01T00:00:00.000Z' }, now)).toBe(false)
  })

  it('drops the digest in the metadata projection', () => {
    const view = toTokenView({
      id: 'id',
      name: 'alice',
      role: 'read',
      hash: 'deadbeef',
      prefix: 'AbCdEfGh',
      createdAt: 'now',
      createdBy: 'admin',
    })
    expect(view).toEqual({ id: 'id', name: 'alice', role: 'read', prefix: 'AbCdEfGh', createdAt: 'now', createdBy: 'admin' })
    expect(JSON.stringify(view)).not.toContain('deadbeef')
  })

  it('parses labels: trims, accepts unicode names, rejects path-shaped or oversized ones', () => {
    expect(TOKEN_NAME_PATTERN.test('alice')).toBe(true)
    expect(parseTokenName('  alice  ')).toBe('alice')
    expect(parseTokenName('张三')).toBe('张三')
    expect(parseTokenName('ops-oncall@example.com')).toBe('ops-oncall@example.com')
    expect(() => parseTokenName('')).toThrow(/invalid name/)
    expect(() => parseTokenName('-leading-dash')).toThrow(/invalid name/)
    expect(() => parseTokenName('a/b')).toThrow(/invalid name/)
    expect(() => parseTokenName('a'.repeat(65))).toThrow(/invalid name/)
    expect(() => parseTokenName(42)).toThrow(/must be a string/)
  })

  it('parses roles and expiries, rejecting past or unparseable ones', () => {
    expect(parseTokenRole('admin')).toBe('admin')
    expect(parseTokenRole('read')).toBe('read')
    expect(() => parseTokenRole('owner')).toThrow(/role must be/)

    expect(parseExpiresAt(undefined)).toBeUndefined()
    expect(parseExpiresAt('')).toBeUndefined()
    expect(parseExpiresAt('2030-01-01T00:00:00Z')).toBe('2030-01-01T00:00:00.000Z')
    expect(() => parseExpiresAt('not-a-date')).toThrow(/ISO date/)
    expect(() => parseExpiresAt(123)).toThrow(/ISO date/)
    expect(() => parseExpiresAt('2020-01-01T00:00:00Z')).toThrow(/future/)
  })
})

describe('token store', () => {
  function fresh(): { store: HubStore; dir: string } {
    const dir = mktmpdir('hub-tokens-')
    return { store: new HubStore({ dataDir: dir }), dir }
  }

  it('persists the roster across a reload and enforces unique live labels', async () => {
    const { store, dir } = fresh()
    await store.init()
    const alice = store.putToken({ name: 'alice', role: 'read', hash: hashToken('a'), prefix: 'aaaaaaaa', createdBy: 'admin' })
    store.putToken({ name: 'bob', role: 'admin', hash: hashToken('b'), prefix: 'bbbbbbbb', createdBy: 'admin' })
    await store.save()

    const reopened = new HubStore({ dataDir: dir })
    await reopened.init()
    expect(reopened.listTokens()).toHaveLength(2)
    expect(reopened.getToken(alice.id)).toMatchObject({ name: 'alice', role: 'read', prefix: 'aaaaaaaa' })
    expect(reopened.findTokenByName('bob')?.role).toBe('admin')
    expect(reopened.findTokenByName('carol')).toBeUndefined()
  })

  it('looks a digest up only while the token is live; revocation frees the label', async () => {
    const { store } = fresh()
    await store.init()
    const alice = store.putToken({ name: 'alice', role: 'read', hash: hashToken('a'), prefix: 'aaaaaaaa', createdBy: 'admin' })
    expect(store.findActiveTokenByHash(hashToken('a'))?.id).toBe(alice.id)
    expect(store.findActiveTokenByHash(hashToken('nope'))).toBeUndefined()

    expect(store.revokeToken(alice.id)).toBe(true)
    expect(store.revokeToken(alice.id)).toBe(false)
    expect(store.revokeToken('missing')).toBe(false)
    // Revoked: no longer authenticates, but the record (and its digest) remains for the audit trail.
    expect(store.findActiveTokenByHash(hashToken('a'))).toBeUndefined()
    expect(store.hasTokenHash(hashToken('a'))).toBe(true)
    expect(store.findTokenByName('alice')).toBeUndefined()
    expect(store.putToken({ name: 'alice', role: 'read', hash: hashToken('a2'), prefix: 'aaaaaaaa', createdBy: 'admin' }).name).toBe('alice')
  })

  it('refuses to exceed the roster cap', async () => {
    const { store } = fresh()
    await store.init()
    for (let i = 0; i < MAX_TOKENS; i++) {
      store.putToken({ name: `user-${i}`, role: 'read', hash: hashToken(`t${i}`), prefix: 'aaaaaaaa', createdBy: 'admin' })
    }
    expect(() => store.putToken({ name: 'overflow', role: 'read', hash: hashToken('x'), prefix: 'aaaaaaaa', createdBy: 'admin' })).toThrow(/roster is full/)
  })

  it('records token actions with the actor and never the digest', async () => {
    const { store, dir } = fresh()
    await store.init()
    const alice = store.putToken({ name: 'alice', role: 'read', hash: hashToken('secret-token'), prefix: 'aaaaaaaa', createdBy: 'root' })
    await store.auditToken('admin', 'token-create', alice, 'root')
    await store.auditToken('admin', 'token-revoke', alice, 'root')

    const records = await store.readAudit(10)
    expect(records.map((r) => r.action)).toEqual(['token-create', 'token-revoke'])
    expect(records[0]).toMatchObject({ role: 'admin', kind: 'token', name: 'alice', actor: 'root' })
    expect(JSON.stringify(records)).not.toContain('secret-token')
    // The digest lives in the encrypted doc, never in the plaintext audit log.
    expect(readFileSync(join(dir, 'audit.log'), 'utf8')).not.toContain(hashToken('secret-token'))
  })
})

describe('token HTTP API', () => {
  let dir: string
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

  /** Issue a token over the API and return its plaintext. */
  async function issue(name: string, role: 'admin' | 'read', extra: Record<string, unknown> = {}): Promise<string> {
    const r = await api('/tokens', { method: 'POST', body: { name, role, ...extra } })
    expect(r.status).toBe(200)
    return r.body.token as string
  }

  beforeEach(async () => {
    dir = mktmpdir('hub-tokens-api-')
    store = new HubStore({ dataDir: dir })
    await store.init()
    server = createHubServer({ store, adminToken: ADMIN, readToken: READ })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolveClose) => server.close(resolveClose))
  })

  it('reports the static bootstrap tokens as source=static on /whoami', async () => {
    expect((await api('/whoami')).body).toEqual({ ok: true, role: 'admin', actor: 'admin', source: 'static' })
    expect((await api('/whoami', { token: READ })).body).toEqual({ ok: true, role: 'read', actor: 'read', source: 'static' })
    expect((await api('/whoami', { token: null })).status).toBe(401)
  })

  it('grants the named holder exactly its role, including an admin token that differs from the other holders', async () => {
    const aliceRead = await issue('alice', 'read')
    const bobAdmin = await issue('bob', 'admin')

    // alice: read works, admin is 403.
    expect((await api('/whoami', { token: aliceRead })).body).toEqual({ ok: true, role: 'read', actor: 'alice', source: 'named' })
    expect((await api('/entries', { token: aliceRead })).status).toBe(200)
    expect((await api('/audit', { token: aliceRead })).status).toBe(403)
    expect((await api('/entries/k8s/prod/ro', { method: 'PUT', token: aliceRead, body: { fields: {} } })).status).toBe(403)

    // bob: full admin surface, and can even issue further tokens.
    expect((await api('/whoami', { token: bobAdmin })).body).toEqual({ ok: true, role: 'admin', actor: 'bob', source: 'named' })
    expect((await api('/entries/k8s/prod/ro', { method: 'PUT', token: bobAdmin, body: { fields: { a: 'b' } } })).status).toBe(200)
    expect((await api('/audit', { token: bobAdmin })).status).toBe(200)
    const issued = await api('/tokens', { method: 'POST', token: bobAdmin, body: { name: 'carol', role: 'read' } })
    expect(issued.status).toBe(200)
    expect(issued.body.createdBy).toBe('bob')
  })

  it('returns the plaintext once and never again — listings and the data file hold no secret', async () => {
    const created = await api('/tokens', { method: 'POST', body: { name: 'alice', role: 'read' } })
    expect(created.status).toBe(200)
    expect(created.body.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(created.body).toMatchObject({ ok: true, name: 'alice', role: 'read', createdBy: 'admin' })
    expect(created.body.revokedAt).toBeUndefined()
    expect(typeof created.body.id).toBe('string')
    expect(created.body.prefix).toBe((created.body.token as string).slice(0, 8))
    expect(created.body.hash).toBeUndefined()

    const list = await api('/tokens')
    expect(list.status).toBe(200)
    const items = list.body as unknown as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0].token).toBeUndefined()
    expect(items[0].hash).toBeUndefined()
    expect(JSON.stringify(list.body)).not.toContain(created.body.token)

    // Neither the plaintext nor its digest is readable off the disk document.
    const raw = readFileSync(join(dir, 'hub-data.json.enc'), 'utf8')
    expect(raw).not.toContain(created.body.token as string)
    expect(raw).not.toContain(hashToken(created.body.token as string))
  })

  it('enforces the lifecycle: revoked and expired tokens stop authenticating, revocation is terminal', async () => {
    const plaintext = await issue('alice', 'read')
    const id = ((await api('/tokens')).body as unknown as Array<{ id: string; name: string }>)[0].id

    expect((await api('/entries', { token: plaintext })).status).toBe(200)
    expect((await api(`/tokens/${id}`, { method: 'DELETE' })).status).toBe(200)
    const after = await api('/entries', { token: plaintext })
    expect(after.status).toBe(401)
    expect(after.body.error).toBe('token revoked or expired')
    expect((await api(`/tokens/${id}`, { method: 'DELETE' })).status).toBe(409)
    expect((await api('/tokens/does-not-exist', { method: 'DELETE' })).status).toBe(404)

    // Expiry is rejected at issue time when already past, and enforced at auth
    // time for a record that expired afterwards (written straight to the store).
    expect((await api('/tokens', { method: 'POST', body: { name: 'eve', role: 'read', expiresAt: '2020-01-01T00:00:00Z' } })).status).toBe(400)
    const expiring = await issue('frank', 'read', { expiresAt: '2030-01-01T00:00:00Z' })
    expect((await api('/entries', { token: expiring })).status).toBe(200)
    const record = store.findTokenByName('frank')!
    store.putToken({ name: 'grace', role: 'read', hash: hashToken('expired-token'), prefix: 'expired-', createdBy: 'test', expiresAt: '2000-01-01T00:00:00Z' })
    expect(record.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    const expired = await api('/entries', { token: 'expired-token' })
    expect(expired.status).toBe(401)
    expect(expired.body.error).toBe('token revoked or expired')
  })

  it('enforces issuance auth and validation, and lets a revoked label be reissued', async () => {
    expect((await api('/tokens', { method: 'POST', body: { name: 'alice', role: 'read' } })).status).toBe(200)
    expect((await api('/tokens')).status).toBe(200)

    // Admin-only surface (including the roster listing).
    expect((await api('/tokens', { token: READ })).status).toBe(403)
    expect((await api('/tokens', { method: 'POST', token: READ, body: { name: 'x', role: 'read' } })).status).toBe(403)
    expect((await api('/tokens', { token: null })).status).toBe(401)

    // Validation, all 400 with {ok:false}.
    expect((await api('/tokens', { method: 'POST', body: { name: 'alice', role: 'read' } })).status).toBe(409)
    expect((await api('/tokens', { method: 'POST', body: { name: 'a/b', role: 'read' } })).status).toBe(400)
    expect((await api('/tokens', { method: 'POST', body: { name: 'x', role: 'owner' } })).status).toBe(400)
    expect((await api('/tokens', { method: 'POST', body: { name: 'x', role: 'read', expiresAt: 'soon' } })).status).toBe(400)
    expect((await api('/tokens', { method: 'POST' })).status).toBe(400)
    expect((await api('/tokens', { method: 'PUT' })).status).toBe(405)
    expect((await api('/tokens/some-id', { method: 'GET' })).status).toBe(405)

    // Revoking frees the label for the next holder of the same role of duty.
    const id = ((await api('/tokens')).body as unknown as Array<{ id: string }>)[0].id
    await api(`/tokens/${id}`, { method: 'DELETE' })
    expect((await api('/tokens', { method: 'POST', body: { name: 'alice', role: 'admin' } })).status).toBe(200)
  })

  it('attributes audits to the named holder and marks the static tokens as un-attributed', async () => {
    const alice = await issue('alice', 'read')
    const bob = await issue('bob', 'admin')
    await api('/entries/k8s/prod/ro', { method: 'PUT', token: bob, body: { fields: { password: 's3cr3t' } } })
    await api('/entries/k8s/prod/ro', { token: alice })
    await api('/entries/k8s/prod/ro', { method: 'DELETE' })

    const records = (await api('/audit')).body as unknown as Array<Record<string, unknown>>
    expect(records.map((r) => r.action)).toEqual(['token-create', 'token-create', 'put', 'resolve', 'delete'])
    // Static bootstrap issuance carries no label; named holders do.
    expect(records.map((r) => r.actor)).toEqual([undefined, undefined, 'bob', 'alice', undefined])
    expect(records[0]).toMatchObject({ kind: 'token', name: 'alice', role: 'admin' })
    // No plaintext token, and no field value, ever reaches the audit log.
    const text = JSON.stringify(records)
    expect(text).not.toContain(alice)
    expect(text).not.toContain(bob)
    expect(text).not.toContain('s3cr3t')
  })

  it('keeps the roster across a hub restart', async () => {
    const plaintext = await issue('alice', 'read')
    await new Promise((resolveClose) => server.close(resolveClose))

    const reopened = new HubStore({ dataDir: dir })
    await reopened.init()
    const restarted = createHubServer({ store: reopened, adminToken: ADMIN, readToken: READ })
    await new Promise<void>((resolveListen) => restarted.listen(0, '127.0.0.1', resolveListen))
    base = `http://127.0.0.1:${(restarted.address() as AddressInfo).port}`
    server = restarted

    expect((await api('/whoami', { token: plaintext })).body).toMatchObject({ role: 'read', actor: 'alice', source: 'named' })
    expect((await api('/tokens')).body as unknown as unknown[]).toHaveLength(1)
  })
})
