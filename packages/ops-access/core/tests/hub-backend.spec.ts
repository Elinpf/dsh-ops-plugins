/**
 * Unit spec for the hub credential source: drives the real plugin with
 * `source: 'hub'` against an in-process mock ops-access-hub (node:http,
 * ephemeral port), covering resolve-time materialization (content → managed
 * path, 0600, skip-when-unchanged), the no-materialize discipline of
 * metadata reads (canResolve/list/getEntry), write-path content upload with
 * envelope merge + probe, delete outcomes, auth headers, and failure modes.
 *
 * The mock hub mirrors the real service's API contract:
 *   GET    /entries                              → fields-free list
 *   GET    /entries/:kind/:name/:tier            → { kind, name, tier, fields, envelope, probe? } | 404
 *   PUT    /entries/:kind/:name/:tier            ← { fields, envelope, probe? }
 *   DELETE /entries/:kind/:name/:tier            → { ok: true } | 404
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z as zod } from 'zod'
import * as plugin from '../src/index.ts'
import type { AccessProvider } from '../src/index.ts'
import { setup } from './harness.ts'

// ── Fixture provider (one file field, optional probe) ───────────────────────

const fileProvider: AccessProvider = {
  kind: 'test',
  schema: zod.object({ kubeconfig: zod.string(), endpoint: zod.string().optional() }),
  fileFields: ['kubeconfig'],
  process: (entry) => ({ ...(entry as Record<string, unknown>) }),
}

const probingProvider: AccessProvider = {
  ...fileProvider,
  probe: async () => ({ status: 'verified' as const, detail: 'probe ran' }),
}

// ── Mock hub ────────────────────────────────────────────────────────────────

interface MockHub {
  url: string
  /** Recorded requests: `{ method, path, authorization, body? }`. */
  requests: Array<{ method: string, path: string, authorization?: string, body?: any }>
  /** Direct store access for fixture setup and assertions. */
  store: Record<string, { kind: string, name: string, envelope: Record<string, unknown>, tiers: Record<string, { fields: Record<string, unknown>, probe?: unknown }> }>
  close: () => Promise<void>
}

function startHub(opts: { readToken?: string, adminToken?: string } = {}): Promise<MockHub> {
  const store: MockHub['store'] = {}
  const requests: MockHub['requests'] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    const fail = (status: number, error: string) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error }))
    }
    // Auth: reads need the read token (when configured), writes the admin token.
    const isWrite = req.method === 'PUT' || req.method === 'DELETE' || url.pathname === '/audit'
    const expected = isWrite ? opts.adminToken : opts.readToken
    if (expected !== undefined && authorization !== `Bearer ${expected}`) {
      fail(401, 'unauthorized')
      return
    }
    const json = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.method === 'GET' && url.pathname === '/entries') {
      requests.push({ method: 'GET', path: '/entries', authorization })
      json(Object.values(store).map((e) => ({
        kind: e.kind,
        name: e.name,
        envelope: e.envelope,
        tiers: Object.fromEntries(Object.entries(e.tiers).map(([t, v]) => [t, { ...(v.probe !== undefined ? { probe: v.probe } : {}) }])),
      })))
      return
    }
    if (segments[0] === 'entries' && segments.length === 4) {
      const [, kind, name, tier] = segments
      const key = `${kind}/${name}`
      if (req.method === 'GET') {
        requests.push({ method: 'GET', path: url.pathname, authorization })
        const entry = store[key]
        const data = entry?.tiers[tier]
        if (!entry || !data) { fail(404, 'entry not found'); return }
        json({ kind, name, tier, fields: data.fields, envelope: entry.envelope, ...(data.probe !== undefined ? { probe: data.probe } : {}) })
        return
      }
      if (req.method === 'PUT') {
        let text = ''
        req.on('data', (c) => { text += c })
        req.on('end', () => {
          const body = JSON.parse(text)
          requests.push({ method: 'PUT', path: url.pathname, authorization, body })
          if (!store[key]) store[key] = { kind, name, envelope: {}, tiers: {} }
          store[key].envelope = body.envelope ?? {}
          store[key].tiers[tier] = { fields: body.fields, ...(body.probe !== undefined ? { probe: body.probe } : {}) }
          json({ ok: true })
        })
        return
      }
      if (req.method === 'DELETE') {
        requests.push({ method: 'DELETE', path: url.pathname, authorization })
        const entry = store[key]
        if (!entry || !entry.tiers[tier]) { fail(404, 'entry not found'); return }
        delete entry.tiers[tier]
        if (Object.keys(entry.tiers).length === 0) delete store[key]
        json({ ok: true })
        return
      }
    }
    fail(404, 'not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        store,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** Seed one entry directly into the mock hub store. */
function seed(hub: MockHub, kind: string, name: string, tier: string, fields: Record<string, unknown>, envelope: Record<string, unknown> = {}, probe?: unknown): void {
  const key = `${kind}/${name}`
  if (!hub.store[key]) hub.store[key] = { kind, name, envelope: {}, tiers: {} }
  hub.store[key].envelope = { ...hub.store[key].envelope, ...envelope }
  hub.store[key].tiers[tier] = { fields, ...(probe !== undefined ? { probe } : {}) }
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('hub source', () => {
  let hub: MockHub
  beforeEach(async () => {
    hub = await startHub()
  })
  afterEach(async () => {
    await hub.close()
  })

  function hubSetup(config: Record<string, unknown> = {}) {
    const s = setup({ config: { source: 'hub', hubUrl: hub.url, ...config } })
    s.handle.register(fileProvider)
    return s
  }

  it('apply throws when source is hub without hubUrl', () => {
    expect(() => setup({ config: { source: 'hub' } })).toThrow(/requires hubUrl/)
  })

  it('resolve materializes file-field content to a managed 0600 path and serves paths in the profile', async () => {
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'clusters: []\n', endpoint: 'https://a' }, { description: 'alpha 环境' })
    const { handle, credentialsDir } = hubSetup()
    const profile = await handle.resolve('test', 'alpha')
    const expectedPath = `${credentialsDir}/test/alpha/ro/kubeconfig`
    expect(profile.fields.kubeconfig).toBe(expectedPath)
    expect(profile.fields.endpoint).toBe('https://a')
    expect(profile.description).toBe('alpha 环境')
    expect(readFileSync(expectedPath, 'utf8')).toBe('clusters: []\n')
    expect(statSync(expectedPath).mode & 0o777).toBe(0o600)
  })

  it('resolve skips the rewrite when the content is unchanged, rewrites on change', async () => {
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'v1' })
    const { handle, credentialsDir } = hubSetup()
    const path = `${credentialsDir}/test/alpha/ro/kubeconfig`
    await handle.resolve('test', 'alpha')
    const first = statSync(path).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await handle.resolve('test', 'alpha')
    expect(statSync(path).mtimeMs).toBe(first)
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'v2' })
    await handle.resolve('test', 'alpha')
    expect(readFileSync(path, 'utf8')).toBe('v2')
  })

  it('resolve errors mention the hub as the source and list available profiles', async () => {
    seed(hub, 'test', 'beta', 'ro', { kubeconfig: 'x' })
    const { handle } = hubSetup()
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(
      /no profile "alpha" for kind "test" in access hub at http:\/\/127\.0\.0\.1:\d+ \(available: beta\)/,
    )
  })

  it('resolve of a missing tier points at the derivation path when rw exists', async () => {
    seed(hub, 'test', 'alpha', 'rw', { kubeconfig: 'x' })
    const { handle } = hubSetup()
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(/no ro tier for profile "alpha".*rw tier is registered/)
  })

  it('canResolve validates WITHOUT materializing (metadata reads write no secret files)', async () => {
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'clusters: []' })
    const { handle, credentialsDir } = hubSetup()
    expect(await handle.canResolve('test', 'alpha', 'ro')).toEqual({ ok: true })
    expect(existsSync(`${credentialsDir}/test/alpha/ro/kubeconfig`)).toBe(false)
    expect(await handle.canResolve('test', 'alpha', 'rw')).toEqual({ ok: false })
    expect(await handle.canResolve('test', 'ghost', 'ro')).toEqual({ ok: false })
  })

  it('list() builds ro profiles with would-be paths, writing nothing', async () => {
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'x' }, { environment: 'prod' })
    seed(hub, 'test', 'beta', 'rw', { kubeconfig: 'y' })
    const { handle, credentialsDir } = hubSetup()
    const profiles = await handle.list()
    expect(profiles).toHaveLength(1)
    expect(profiles[0].fields.kubeconfig).toBe(`${credentialsDir}/test/alpha/ro/kubeconfig`)
    expect(profiles[0].environment).toBe('prod')
    expect(existsSync(`${credentialsDir}/test`)).toBe(false)
  })

  it('listAll merges tier status with probes from the listing', async () => {
    const probe = { status: 'verified', probedAt: '2026-01-01T00:00:00.000Z' }
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'x' }, { description: 'd' }, probe)
    const { handle } = hubSetup()
    const entries = await handle.listAll()
    expect(entries).toHaveLength(1)
    expect(entries[0].envelope.description).toBe('d')
    expect(entries[0].tiers.ro).toEqual({ ok: true, probe })
    expect(entries[0].tiers.rw).toEqual({ ok: false })
  })

  it('getEntry withholds file fields but reports their set status', async () => {
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'secret-content', endpoint: 'https://a' }, { name: 'Alpha' })
    const { handle } = hubSetup()
    const entry = await handle.getEntry('test', 'alpha', 'ro')
    expect(entry).not.toBeNull()
    expect(entry!.fields).toEqual({ endpoint: 'https://a' })
    expect(entry!.fileFields).toEqual({ kubeconfig: true })
    expect(entry!.displayName).toBe('Alpha')
    // And it wrote nothing to disk.
    expect(await handle.getEntry('test', 'ghost', 'ro')).toBeNull()
  })

  it('writeEntry uploads file CONTENT read from the managed path, plus the probe', async () => {
    hub.close()
    hub = await startHub()
    const s = setup({ config: { source: 'hub', hubUrl: hub.url } })
    s.handle.register(probingProvider)
    const keyPath = join(s.dir, 'staged-kubeconfig')
    writeFileSync(keyPath, 'clusters: [real]\n')
    await s.handle.writeEntry('test', 'alpha', 'ro', { kubeconfig: keyPath }, { description: 'new entry' })
    const put = hub.requests.find((r) => r.method === 'PUT')
    expect(put).toBeDefined()
    expect(put!.path).toBe('/entries/test/alpha/ro')
    expect(put!.body.fields.kubeconfig).toBe('clusters: [real]\n')
    expect(put!.body.envelope).toEqual({ description: 'new entry' })
    expect(put!.body.probe.status).toBe('verified')
    expect(typeof put!.body.probe.probedAt).toBe('string')
    // And the hub now serves the content back on resolve.
    const profile = await s.handle.resolve('test', 'alpha')
    expect(readFileSync(String(profile.fields.kubeconfig), 'utf8')).toBe('clusters: [real]\n')
  })

  it('writeEntry envelope merge: omitted preserves, empty string deletes', async () => {
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'x' }, { description: 'keep me', environment: 'prod' })
    const s = hubSetup()
    const staged = join(s.dir, 'rw-kubeconfig')
    writeFileSync(staged, 'rw-content\n')
    await s.handle.writeEntry('test', 'alpha', 'rw', { kubeconfig: staged }, { environment: '' })
    const entry = hub.store['test/alpha']
    expect(entry.envelope).toEqual({ description: 'keep me' })
    expect(entry.tiers.rw.fields).toEqual({ kubeconfig: 'rw-content\n' })
    expect(entry.tiers.ro.fields).toEqual({ kubeconfig: 'x' })
  })

  it('writeEntry rejects schema-invalid fields BEFORE any hub write', async () => {
    const { handle } = hubSetup()
    await expect(handle.writeEntry('test', 'alpha', 'ro', {} as Record<string, unknown>)).rejects.toThrow(/invalid entry test\.alpha/)
    expect(hub.requests.filter((r) => r.method === 'PUT')).toHaveLength(0)
  })

  it('deleteEntry deletes the tier on the hub and reports entry-vs-tier outcome', async () => {
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'x' })
    seed(hub, 'test', 'alpha', 'rw', { kubeconfig: 'y' })
    seed(hub, 'test', 'beta', 'ro', { kubeconfig: 'z' })
    const { handle, credentialsDir } = hubSetup()
    mkdirSync(`${credentialsDir}/test/alpha/ro`, { recursive: true })
    writeFileSync(`${credentialsDir}/test/alpha/ro/kubeconfig`, 'x')
    expect(await handle.deleteEntry('test', 'alpha', 'ro')).toBe(true)
    expect(Object.keys(hub.store['test/alpha'].tiers)).toEqual(['rw'])
    expect(existsSync(`${credentialsDir}/test/alpha/ro`)).toBe(false)
    // Last tier → the whole entry goes, and its credential directory too.
    expect(await handle.deleteEntry('test', 'alpha', 'rw')).toBe(true)
    expect(hub.store['test/alpha']).toBeUndefined()
    expect(existsSync(`${credentialsDir}/test/alpha`)).toBe(false)
    expect(await handle.deleteEntry('test', 'ghost', 'ro')).toBe(false)
  })

  it('register_access flows through the hub: staged content file is uploaded', async () => {
    const s = hubSetup()
    const result = await s.callRegisterAccess({
      profile: 'test/alpha',
      fields: { kubeconfig: 'clusters: [from-tool]\n' },
      description: 'via tool',
    })
    expect(result.ok).toBe(true)
    const put = hub.requests.find((r) => r.method === 'PUT')
    expect(put!.body.fields.kubeconfig).toBe('clusters: [from-tool]\n')
    expect(put!.body.envelope).toEqual({ description: 'via tool' })
  })

  it('auth tokens ride the Authorization header; read for GET, admin for writes', async () => {
    hub.close()
    hub = await startHub({ readToken: 'read-secret', adminToken: 'admin-secret' })
    const s = setup({ config: { source: 'hub', hubUrl: hub.url, hubToken: 'read-secret', hubAdminToken: 'admin-secret' } })
    s.handle.register(fileProvider)
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'x' })
    await s.handle.resolve('test', 'alpha')
    const staged = join(s.dir, 'staged')
    writeFileSync(staged, 'rw-content\n')
    await s.handle.writeEntry('test', 'alpha', 'rw', { kubeconfig: staged })
    const get = hub.requests.find((r) => r.method === 'GET' && r.path.includes('/ro'))
    const put = hub.requests.find((r) => r.method === 'PUT')
    expect(get!.authorization).toBe('Bearer read-secret')
    expect(put!.authorization).toBe('Bearer admin-secret')
  })

  it('hub rejection surfaces the status and message, never the token', async () => {
    hub.close()
    hub = await startHub({ readToken: 'right' })
    const s = setup({ config: { source: 'hub', hubUrl: hub.url, hubToken: 'wrong' } })
    s.handle.register(fileProvider)
    seed(hub, 'test', 'alpha', 'ro', { kubeconfig: 'x' })
    await expect(s.handle.resolve('test', 'alpha')).rejects.toThrow(/rejected GET .* \(401\)/)
    await expect(s.handle.resolve('test', 'alpha')).rejects.toThrow(/unauthorized/)
    await expect(s.handle.resolve('test', 'alpha')).rejects.not.toThrow(/wrong/)
  })

  it('an unreachable hub fails resolve loud', async () => {
    const { handle } = hubSetup()
    await hub.close()
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(/cannot reach access hub/)
    // Re-create for afterEach.
    hub = await startHub()
  })

  it('help() describes the hub source instead of the registry file', () => {
    const { handle } = hubSetup()
    const text = handle.help()
    expect(text).toContain(`Source: access hub at ${hub.url}`)
    expect(text).not.toContain('version: 1')
  })
})
