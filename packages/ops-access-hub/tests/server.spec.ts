/**
 * API spec for the hub server, driven over real HTTP on an ephemeral port
 * (`server.listen(0)`) against a tmp data-dir: auth (401/403), CRUD flow,
 * last-tier cascade delete, probe write-back, the no-field-values listing
 * guarantee, audit append + limit, and validation errors.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubStore } from '../src/store.ts'
import { createHubServer } from '../src/server.ts'

const ADMIN = 'test-admin-token'
const READ = 'test-read-token'

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-server-'))
  store = new HubStore({ dataDir: dir })
  await store.init()
  server = createHubServer({ store, adminToken: ADMIN, readToken: READ })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolveClose) => server.close(resolveClose))
})

describe('unauthenticated surface', () => {
  it('GET /health answers without a token', async () => {
    const r = await api('/health', { token: null })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })

  it('GET / serves the web UI without a token', async () => {
    const r = await api('/', { token: null })
    expect(r.status).toBe(200)
    expect(String(r.body)).toContain('dsh-ops-access-hub')
  })
})

describe('auth', () => {
  it('rejects a missing token with 401', async () => {
    const r = await api('/entries', { token: null })
    expect(r.status).toBe(401)
    expect(r.body.ok).toBe(false)
  })

  it('rejects a wrong token with 401', async () => {
    const r = await api('/entries', { token: 'wrong-token' })
    expect(r.status).toBe(401)
  })

  it('rejects the read token on admin endpoints with 403', async () => {
    const put = await api('/entries/k8s/prod/ro', { method: 'PUT', token: READ, body: { fields: {} } })
    expect(put.status).toBe(403)
    const audit = await api('/audit', { token: READ })
    expect(audit.status).toBe(403)
    const del = await api('/entries/k8s/prod/ro', { method: 'DELETE', token: READ })
    expect(del.status).toBe(403)
  })

  it('lets the read token list and resolve entries', async () => {
    await api('/entries/k8s/prod/ro', { method: 'PUT', body: { fields: { a: 'b' } } })
    expect((await api('/entries', { token: READ })).status).toBe(200)
    expect((await api('/entries/k8s/prod/ro', { token: READ })).status).toBe(200)
  })
})

describe('CRUD', () => {
  it('runs the full put/get/list/delete flow', async () => {
    const put = await api('/entries/k8s/prod/ro', {
      method: 'PUT',
      body: { fields: { kubeconfig: 'content-here' }, envelope: { description: '生产集群', environment: 'prod' } },
    })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ ok: true })

    const got = await api('/entries/k8s/prod/ro', { token: READ })
    expect(got.status).toBe(200)
    expect(got.body.kind).toBe('k8s')
    expect(got.body.name).toBe('prod')
    expect(got.body.tier).toBe('ro')
    expect(got.body.fields).toEqual({ kubeconfig: 'content-here' })
    expect(got.body.envelope).toEqual({ description: '生产集群', environment: 'prod' })

    const missing = await api('/entries/k8s/prod/rw', { token: READ })
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ ok: false, error: 'entry not found' })

    const del = await api('/entries/k8s/prod/ro', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await api('/entries/k8s/prod/ro')).status).toBe(404)
    const delAgain = await api('/entries/k8s/prod/ro', { method: 'DELETE' })
    expect(delAgain.status).toBe(404)
    expect(delAgain.body).toEqual({ ok: false, error: 'entry not found' })
  })

  it('never exposes field values in GET /entries', async () => {
    await api('/entries/k8s/prod/ro', { method: 'PUT', body: { fields: { password: 's3cr3t-value' } } })
    const list = await api('/entries')
    expect(list.status).toBe(200)
    expect(Array.isArray(list.body)).toBe(true)
    expect(JSON.stringify(list.body)).not.toContain('s3cr3t-value')
    const entry = (list.body as unknown as Array<Record<string, unknown>>)[0]
    expect(entry.kind).toBe('k8s')
    expect(entry.name).toBe('prod')
    expect(entry.tiers).toEqual({ ro: {} })
    expect(typeof entry.updatedAt).toBe('string')
  })

  it('replaces the envelope wholesale on PUT when provided', async () => {
    await api('/entries/k8s/prod/ro', {
      method: 'PUT',
      body: { fields: { a: 1 }, envelope: { description: 'old', environment: 'prod' } },
    })
    await api('/entries/k8s/prod/rw', { method: 'PUT', body: { fields: { b: 2 }, envelope: { description: 'new' } } })
    const got = await api('/entries/k8s/prod/rw')
    expect(got.body.envelope).toEqual({ description: 'new' })
    // The other tier keeps its fields under the shared (replaced) envelope.
    const ro = await api('/entries/k8s/prod/ro')
    expect(ro.body.fields).toEqual({ a: 1 })
    expect(ro.body.envelope).toEqual({ description: 'new' })
  })

  it('deletes the whole entry when its last tier is removed', async () => {
    await api('/entries/k8s/prod/ro', { method: 'PUT', body: { fields: { a: 1 } } })
    await api('/entries/k8s/prod/rw', { method: 'PUT', body: { fields: { b: 2 } } })
    await api('/entries/k8s/prod/ro', { method: 'DELETE' })
    let list = (await api('/entries')).body as Array<{ tiers: Record<string, unknown> }>
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0].tiers)).toEqual(['rw'])
    await api('/entries/k8s/prod/rw', { method: 'DELETE' })
    list = (await api('/entries')).body as Array<{ tiers: Record<string, unknown> }>
    expect(list).toHaveLength(0)
    expect(store.getEntry('k8s', 'prod')).toBeUndefined()
  })

  it('writes probe state back and shows it in the listing', async () => {
    const probe = { status: 'verified', detail: 'kubectl ok', probedAt: new Date().toISOString() }
    await api('/entries/k8s/prod/ro', { method: 'PUT', body: { fields: { a: 1 }, probe } })
    const got = await api('/entries/k8s/prod/ro')
    expect(got.body.probe).toEqual(probe)
    const list = (await api('/entries')).body as Array<{ tiers: { ro: { probe: unknown } } }>
    expect(list[0].tiers.ro.probe).toEqual(probe)
  })

  it('rejects bad names, bad tiers and non-object fields with {ok:false,error} and no values', async () => {
    const badName = await api('/entries/k8s/not%20a-name/ro', { method: 'PUT', body: { fields: { s: 'dont-leak' } } })
    expect(badName.status).toBe(400)
    expect(badName.body.ok).toBe(false)
    expect(JSON.stringify(badName.body)).not.toContain('dont-leak')

    const badKind = await api('/entries/-bad/prod/ro', { method: 'PUT', body: { fields: {} } })
    expect(badKind.status).toBe(400)

    const badTier = await api('/entries/k8s/prod/admin', { method: 'PUT', body: { fields: {} } })
    expect(badTier.status).toBe(400)

    const badFields = await api('/entries/k8s/prod/ro', { method: 'PUT', body: { fields: ['array'] } })
    expect(badFields.status).toBe(400)
    expect(badFields.body.ok).toBe(false)
  })
})

describe('audit', () => {
  it('records resolve/put/delete with role and never field values; list is not recorded', async () => {
    await api('/entries/k8s/prod/ro', { method: 'PUT', body: { fields: { password: 's3cr3t' } } })
    await api('/entries/k8s/prod/ro', { token: READ }) // resolve
    await api('/entries') // list: not audited
    await api('/entries/k8s/prod/ro', { method: 'DELETE' })

    const r = await api('/audit')
    expect(r.status).toBe(200)
    const records = r.body as unknown as Array<Record<string, unknown>>
    expect(records.map((x) => x.action)).toEqual(['put', 'resolve', 'delete'])
    expect(records.map((x) => x.role)).toEqual(['admin', 'read', 'admin'])
    expect(records[0]).toMatchObject({ kind: 'k8s', name: 'prod', tier: 'ro' })
    expect(JSON.stringify(records)).not.toContain('s3cr3t')
    expect(typeof records[0].ts).toBe('string')
  })

  it('honors ?limit=N (most recent N)', async () => {
    for (let i = 0; i < 5; i++) {
      await api(`/entries/k8s/p${i}/ro`, { method: 'PUT', body: { fields: {} } })
    }
    const r = await api('/audit?limit=2')
    const records = r.body as unknown as Array<{ name: string }>
    expect(records.map((x) => x.name)).toEqual(['p3', 'p4'])
  })
})

describe('persistence', () => {
  it('survives a store reload and never writes plaintext secrets to disk', async () => {
    await api('/entries/k8s/prod/ro', { method: 'PUT', body: { fields: { password: 's3cr3t-on-disk' } } })
    const raw = readFileSync(join(dir, 'hub-data.json.enc'), 'utf8')
    expect(raw).not.toContain('s3cr3t-on-disk')

    const reopened = new HubStore({ dataDir: dir })
    await reopened.init()
    expect(reopened.getEntry('k8s', 'prod')?.tiers.ro?.fields).toEqual({ password: 's3cr3t-on-disk' })
  })
})

describe('registration requests', () => {
  const BODY = {
    kind: 'ssh',
    name: 'web-01',
    tier: 'rw',
    fields: { host: '10.0.0.1', key: 'PRIVATE-KEY-CONTENT' },
    envelope: { description: 'web server' },
    reason: 'need rw for disk resize',
  }

  it('runs the submit → review → approve lifecycle', async () => {
    const submitted = await api('/requests', { method: 'POST', body: BODY })
    expect(submitted.status).toBe(200)
    const id = submitted.body.id as string
    expect(typeof id).toBe('string')

    // Listing carries metadata + field sizes, never values.
    const list = await api('/requests?status=pending', { token: READ })
    expect(list.status).toBe(200)
    const item = (list.body as unknown as Array<Record<string, unknown>>)[0]
    expect(item).toMatchObject({ id, kind: 'ssh', name: 'web-01', tier: 'rw', status: 'pending', reason: BODY.reason })
    expect(item.fields).toEqual({ host: 8, key: 19 })
    expect(JSON.stringify(list.body)).not.toContain('PRIVATE-KEY-CONTENT')

    // Review (admin only) exposes values.
    const denied = await api(`/requests/${id}`, { token: READ })
    expect(denied.status).toBe(403)
    const detail = await api(`/requests/${id}`)
    expect(detail.status).toBe(200)
    expect((detail.body.fields as Record<string, unknown>).key).toBe('PRIVATE-KEY-CONTENT')

    // Approval writes the tier and wipes the request's fields.
    const decided = await api(`/requests/${id}/decide`, { method: 'POST', body: { approved: true } })
    expect(decided.status).toBe(200)
    const entry = await api('/entries/ssh/web-01/rw', { token: READ })
    expect(entry.status).toBe(200)
    expect((entry.body.fields as Record<string, unknown>).key).toBe('PRIVATE-KEY-CONTENT')
    const after = await api(`/requests/${id}`)
    expect((after.body as Record<string, unknown>).status).toBe('approved')
    expect((after.body as Record<string, unknown>).fields).toEqual({})
  })

  it('rejects without writing the tier', async () => {
    const { body } = await api('/requests', { method: 'POST', body: BODY })
    const r = await api(`/requests/${body.id}/decide`, { method: 'POST', body: { approved: false } })
    expect(r.status).toBe(200)
    const entry = await api('/entries/ssh/web-01/rw', { token: READ })
    expect(entry.status).toBe(404)
    const after = await api(`/requests/${body.id}`)
    expect((after.body as Record<string, unknown>).status).toBe('rejected')
  })

  it('409s on re-deciding a settled request and 404s on unknown ids', async () => {
    const { body } = await api('/requests', { method: 'POST', body: BODY })
    await api(`/requests/${body.id}/decide`, { method: 'POST', body: { approved: true } })
    const again = await api(`/requests/${body.id}/decide`, { method: 'POST', body: { approved: false } })
    expect(again.status).toBe(409)
    const missing = await api('/requests/nope/decide', { method: 'POST', body: { approved: true } })
    expect(missing.status).toBe(404)
  })

  it('enforces auth and validation', async () => {
    expect((await api('/requests', { method: 'POST', token: READ, body: BODY })).status).toBe(403)
    expect((await api('/requests', { method: 'POST', token: null, body: BODY })).status).toBe(401)
    const { body } = await api('/requests', { method: 'POST', body: BODY })
    expect((await api(`/requests/${body.id}/decide`, { method: 'POST', token: READ, body: { approved: true } })).status).toBe(403)
    expect((await api('/requests', { method: 'POST', body: { ...BODY, kind: 'bad/kind' } })).status).toBe(400)
    expect((await api('/requests', { method: 'POST', body: { ...BODY, fields: 'x' } })).status).toBe(400)
    expect((await api(`/requests/${body.id}/decide`, { method: 'POST', body: { approved: 'yes' } })).status).toBe(400)
    expect((await api('/requests?status=bogus', { token: READ })).status).toBe(400)
  })

  it('audits request + decide without field values', async () => {
    const { body } = await api('/requests', { method: 'POST', body: BODY })
    await api(`/requests/${body.id}/decide`, { method: 'POST', body: { approved: true } })
    const audit = await api('/audit')
    const actions = (audit.body as unknown as Array<Record<string, unknown>>).map((r) => r.action)
    expect(actions).toContain('request')
    expect(actions).toContain('approve')
    expect(JSON.stringify(audit.body)).not.toContain('PRIVATE-KEY-CONTENT')
  })
})
