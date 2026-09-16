/**
 * Spec for the hub knowledge-base routes (`/cases`): the read-role write
 * relaxation, metadata-only index, hit counting, admin-only delete, input
 * validation, the store's MAX_CASES cap, and encrypted-at-rest persistence.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubStore, MAX_CASES } from '../src/store.ts'
import { createHubServer } from '../src/server.ts'
import { mktmpdir } from '@elinpf/dsh-ops-test-support/tmpdir'

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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const CASE = {
  title: 'CSI 卡住因为 Ceph 满',
  symptoms: ['pvc pending', 'csi operation stuck'],
  rootCause: 'Ceph 存储 99% 满, 阻塞 OMAP 写入',
  fix: '扩容 osd 并重启 csi 插件',
  methodology: 'ceph df 看到使用率 99%; journalctl -u ceph-osd 有 OMAP write slow 日志, 排除网络方向',
  difficulty: 3,
  tags: ['ceph', 'csi'],
}

async function createCase(body: unknown = CASE, token: string | null = READ) {
  return api('/cases', { method: 'POST', token, body })
}

beforeEach(async () => {
  dir = mktmpdir('hub-cases-')
  store = new HubStore({ dataDir: dir })
  await store.init()
  server = createHubServer({ store, adminToken: ADMIN, readToken: READ })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolveClose) => server.close(resolveClose))
})

describe('case CRUD', () => {
  it('read token can create, read and update a case', async () => {
    const created = await createCase()
    expect(created.status).toBe(200)
    const id = created.body.id as string
    expect(id).toBeTruthy()

    const full = await api(`/cases/${id}`, { token: READ })
    expect(full.status).toBe(200)
    expect(full.body).toMatchObject({ ...CASE, hitCount: 0 })
    expect(typeof full.body.createdAt).toBe('string')

    const updated = await api(`/cases/${id}`, { method: 'PUT', token: READ, body: { fix: '先清理快照再扩容' } })
    expect(updated.status).toBe(200)
    const after = await api(`/cases/${id}`, { token: READ })
    expect(after.body.fix).toBe('先清理快照再扩容')
    expect(after.body.title).toBe(CASE.title) // untouched fields survive
  })

  it('GET /cases returns index rows without full-text fields', async () => {
    const created = await createCase()
    const index = await api('/cases', { token: READ })
    expect(index.status).toBe(200)
    const rows = index.body as unknown as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: created.body.id, title: CASE.title, symptoms: CASE.symptoms, tags: CASE.tags, hitCount: 0 })
    expect(rows[0]).not.toHaveProperty('rootCause')
    expect(rows[0]).not.toHaveProperty('fix')
  })

  it('POST /cases/:id/hit bumps the hit count, readable by the read token', async () => {
    const created = await createCase()
    const id = created.body.id as string
    expect((await api(`/cases/${id}/hit`, { method: 'POST', token: READ })).status).toBe(200)
    expect((await api(`/cases/${id}/hit`, { method: 'POST', token: READ })).status).toBe(200)
    const full = await api(`/cases/${id}`, { token: READ })
    expect(full.body.hitCount).toBe(2)
  })

  it('DELETE requires the admin token', async () => {
    const created = await createCase()
    const id = created.body.id as string
    expect((await api(`/cases/${id}`, { method: 'DELETE', token: READ })).status).toBe(403)
    expect((await api(`/cases/${id}`, { method: 'DELETE', token: ADMIN })).status).toBe(200)
    expect((await api(`/cases/${id}`, { token: READ })).status).toBe(404)
  })

  it('rejects unknown ids with 404 on get/put/hit/delete', async () => {
    expect((await api('/cases/nope', { token: READ })).status).toBe(404)
    expect((await api('/cases/nope', { method: 'PUT', token: READ, body: { fix: 'x' } })).status).toBe(404)
    expect((await api('/cases/nope/hit', { method: 'POST', token: READ })).status).toBe(404)
    expect((await api('/cases/nope', { method: 'DELETE', token: ADMIN })).status).toBe(404)
  })

  it('rejects unauthenticated access with 401', async () => {
    expect((await api('/cases', { token: null })).status).toBe(401)
    expect((await createCase(CASE, null)).status).toBe(401)
  })
})

describe('validation', () => {
  it('POST requires non-empty title/rootCause/fix', async () => {
    for (const body of [
      { ...CASE, title: '' },
      { symptoms: CASE.symptoms, rootCause: CASE.rootCause }, // no title/fix
      { ...CASE, fix: 42 },
    ]) {
      const r = await createCase(body)
      expect(r.status).toBe(400)
    }
  })

  it('rejects non-string-array symptoms/tags', async () => {
    expect((await createCase({ ...CASE, symptoms: 'pvc pending' })).status).toBe(400)
    expect((await createCase({ ...CASE, tags: [1, 2] })).status).toBe(400)
  })

  it('validates difficulty as an integer 1-5', async () => {
    for (const difficulty of [0, 6, 2.5, 'hard']) {
      expect((await createCase({ ...CASE, difficulty })).status).toBe(400)
    }
    const ok = await createCase({ ...CASE, difficulty: 5 })
    expect(ok.status).toBe(200)
    const full = await api(`/cases/${ok.body.id}`, { token: READ })
    expect(full.body.difficulty).toBe(5)
    expect(full.body.methodology).toBe(CASE.methodology)
  })

  it('PUT rejects an empty field set', async () => {
    const created = await createCase()
    const r = await api(`/cases/${created.body.id}`, { method: 'PUT', token: READ, body: {} })
    expect(r.status).toBe(400)
  })

  it('rejects a case larger than 32KB', async () => {
    const r = await createCase({ ...CASE, evidence: 'x'.repeat(33 * 1024) })
    expect(r.status).toBe(400)
  })
})

describe('store', () => {
  it('persists cases through save + re-init (encrypted at rest)', async () => {
    await createCase()
    const again = new HubStore({ dataDir: dir })
    await again.init()
    const rows = again.listCases()
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe(CASE.title)
  })

  it('refuses creations past MAX_CASES', async () => {
    for (let i = 0; i < MAX_CASES; i++) store.putCase({ ...CASE, title: `case-${i}` })
    expect(() => store.putCase(CASE)).toThrow(/full/)
  })

  it('updates keep hitCount and createdAt', async () => {
    const record = store.putCase(CASE)!
    store.hitCase(record.id)
    const updated = store.putCase({ fix: '新修复' }, record.id)!
    expect(updated.hitCount).toBe(1)
    expect(updated.createdAt).toBe(record.createdAt)
    expect(updated.fix).toBe('新修复')
  })

  it('audits case actions without content', async () => {
    const created = await createCase()
    const id = created.body.id as string
    await api(`/cases/${id}/hit`, { method: 'POST', token: READ })
    await api(`/cases/${id}`, { method: 'DELETE', token: ADMIN })
    const audit = await store.readAudit(10)
    expect(audit.map((a) => a.action)).toEqual(['case-put', 'case-hit', 'case-delete'])
    for (const record of audit) {
      expect(record.kind).toBe('case')
      expect(record.title).toBe(CASE.title)
      expect(JSON.stringify(record)).not.toContain(CASE.rootCause)
    }
  })
})
