/**
 * ops-access-ui spec: host-half export shape (empty by design — client
 * discovery only), the client @ source driven through mock ctx + fetch, and
 * the settings.section credential-management page (registration + admin API
 * functions + degradation).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as host from '../src/index.ts'
import * as client from '../src/client.ts'
import type { AdminEntry, KindDescriptor } from '../src/client.ts'

// ── Host half ────────────────────────────────────────────────────────────────

describe('host half', () => {
  it('is a function plugin with an intentionally empty apply (discovery-only row)', () => {
    expect(host.name).toBe('ops-access-ui')
    expect(host.inject).toEqual([])
    expect(host.Config).toBeDefined()
    expect('default' in host).toBe(false)
    expect(() => host.apply({} as any, {})).not.toThrow()
  })
})

// ── Client half: shared setup ────────────────────────────────────────────────

const WIRE = [
  { kind: 'k8s', name: 'prod', description: '生产集群', environment: 'prod', ro: true, rw: true, mention: '@[k8s/prod](dsh-access:AAAA)' },
  { kind: 'ssh', name: 'node-1', ro: true, rw: false, mention: '@[ssh/node-1](dsh-access:BBBB)' },
]

const ADMIN_ENTRIES: AdminEntry[] = [
  {
    kind: 'k8s', name: 'prod',
    envelope: { description: '生产集群', environment: 'prod' },
    tiers: { ro: { ok: true }, rw: { ok: true } },
  },
  {
    kind: 'ssh', name: 'node-1',
    envelope: {},
    tiers: { ro: { ok: true }, rw: { ok: false, error: 'not registered' } },
  },
]

const KIND_DESCRIPTORS: KindDescriptor[] = [
  {
    kind: 'k8s',
    jsonSchema: {
      type: 'object',
      properties: {
        kubeconfig: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['kubeconfig'],
      additionalProperties: false,
    },
    fieldsDoc: 'kubeconfig: path to kubeconfig file',
  },
  {
    kind: 'ssh',
    jsonSchema: {
      type: 'object',
      properties: {
        privateKey: { type: 'string' },
      },
      required: ['privateKey'],
      additionalProperties: false,
    },
  },
]

function setupClient(opts: { opsPanels?: boolean } = {}) {
  const sources: any[] = []
  const sections: any[] = []
  const panels: any[] = []
  const ctx: any = {
    get: (key: string) => {
      if (key === 'inputTriggers')
        return { registerSource: (s: any) => { sources.push(s); return () => {} } }
      if (key === 'slots')
        return {
          inject: (_slot: string, factory: () => unknown) => { factory(); return () => {} },
          register: (opts: any, component: any) => { sections.push({ ...opts, component }); return () => {} },
        }
      return undefined
    },
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps[0] === 'opsPanels' && opts.opsPanels !== false) {
        cb({
          opsPanels: { registerPanel: (def: any) => { panels.push(def); return () => {} } },
          effect: (fn: () => () => void) => { fn() },
        })
      }
    },
    effect: (fn: () => () => void) => { fn() },
  }
  client.apply(ctx)
  return { sources, source: sources[0], sections, panels }
}

// ── Client half: @ source ────────────────────────────────────────────────────

describe('client @ source', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('is a function plugin with static inject on inputTriggers and slots', () => {
    expect(client.name).toBe('ops-access-ui-client')
    expect(client.inject).toEqual(['inputTriggers', 'slots'])
    expect('default' in client).toBe(false)
  })

  it('registers one access source on the @ trigger', () => {
    const { sources } = setupClient()
    expect(sources).toHaveLength(1)
    expect(sources[0].trigger).toBe('@')
    expect(sources[0].name).toBe('access')
  })

  it('candidates: fetches the route, maps wire candidates, carries the mention in value', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => WIRE,
    })))
    const { source } = setupClient()
    const out = await source.candidates({ sessionId: 's1' }, { query: 'pro', signal: new AbortController().signal })
    expect(fetch).toHaveBeenCalledWith('/ops-access/list?query=pro', expect.anything())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      name: 'k8s/prod', description: '生产集群', hint: 'prod', value: '@[k8s/prod](dsh-access:AAAA)',
    })
    expect(out[1].hint).toBeUndefined()
  })

  it('candidates: rw-only entries get an ro-missing badge in the description', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [
        { kind: 'k8s', name: 'pf-test', description: '个人测试集群', environment: 'test', ro: false, rw: true, mention: '@[k8s/pf-test](dsh-access:CCCC)' },
        { kind: 'k8s', name: 'bare', ro: false, rw: true, mention: '@[k8s/bare](dsh-access:DDDD)' },
      ],
    })))
    const { source } = setupClient()
    const out = await source.candidates({ sessionId: 's1' }, { query: '', signal: undefined })
    expect(out[0].description).toBe('个人测试集群 — ro 未注册（可由 rw 派生）')
    expect(out[1].description).toBe('ro 未注册（可由 rw 派生）')
    expect(out[0].hint).toBe('test')
  })

  it('candidates: 404 (ops preset absent) and network failure degrade to empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const { source } = setupClient()
    expect(await source.candidates({ sessionId: 's1' }, { query: '', signal: undefined })).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await source.candidates({ sessionId: 's1' }, { query: '', signal: undefined })).toEqual([])
  })

  it('onPick inserts the mention as ref with @label clipboard text; codec is identity', async () => {
    const { source } = setupClient()
    const outcome = source.onPick({ candidate: { name: 'k8s/prod', value: '@[k8s/prod](dsh-access:AAAA)' } })
    expect(outcome).toEqual({
      insert: {
        source: 'access',
        ref: '@[k8s/prod](dsh-access:AAAA)',
        label: 'k8s/prod',
        clipboardText: '@k8s/prod',
      },
    })
    expect(source.codec.clipboardText('x')).toBe('x')
    expect(await source.codec.serialize('x', undefined)).toBe('x')
    // A candidate without a value is a miss.
    expect(source.onPick({ candidate: { name: 'broken' } })).toBeUndefined()
  })
})

// ── Client half: settings.section registration ───────────────────────────────

describe('settings.section registration', () => {
  it('registers one settings.section entry with id=ops-access-admin and label "凭证管理"', () => {
    const { sections } = setupClient()
    const adminSections = sections.filter((s) => s.name === 'settings.section')
    expect(adminSections).toHaveLength(1)
    expect(adminSections[0].id).toBe('ops-access-admin')
    expect(adminSections[0].label).toBe('凭证管理')
    expect(adminSections[0].order).toBe(20)
    expect(typeof adminSections[0].component).toBe('function')
  })

  it('registers the @ source and the settings.section independently', () => {
    const { sources, sections } = setupClient()
    expect(sources).toHaveLength(1)
    expect(sections.filter((s) => s.name === 'settings.section')).toHaveLength(1)
  })

  it('registers settings.section even when inputTriggers is absent (graceful independence)', () => {
    const sections: any[] = []
    const ctx: any = {
      get: (key: string) => {
        if (key === 'slots')
          return {
            inject: (_slot: string, factory: () => unknown) => { factory(); return () => {} },
            register: (opts: any, component: any) => { sections.push({ ...opts, component }); return () => {} },
          }
        return undefined
      },
      effect: (fn: () => () => void) => { fn() },
      // opsPanels never provided here → the deferred inject simply never fires.
      inject: () => {},
    }
    client.apply(ctx)
    // No @ source registered (inputTriggers absent), but settings.section is
    expect(sections).toHaveLength(1)
    expect(sections[0].id).toBe('ops-access-admin')
  })
})

// ── Client half: admin API functions ─────────────────────────────────────────

describe('admin API: fetchAdminList', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('fetches GET /ops-access/admin/list and returns AdminEntry[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ADMIN_ENTRIES,
    })))
    const result = await client.fetchAdminList()
    expect(fetch).toHaveBeenCalledWith('/ops-access/admin/list', expect.anything())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ kind: 'k8s', name: 'prod' })
    expect(result[0].tiers.ro.ok).toBe(true)
    expect(result[0].tiers.rw.ok).toBe(true)
    expect(result[1].tiers.rw.ok).toBe(false)
    expect(result[1].tiers.rw.error).toBe('not registered')
  })

  it('degrades to [] on 404 (ops preset absent)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    expect(await client.fetchAdminList()).toEqual([])
  })

  it('degrades to [] on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await client.fetchAdminList()).toEqual([])
  })
})

describe('admin API: fetchKinds', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('fetches GET /ops-access/admin/kinds and returns KindDescriptor[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => KIND_DESCRIPTORS,
    })))
    const result = await client.fetchKinds()
    expect(fetch).toHaveBeenCalledWith('/ops-access/admin/kinds', expect.anything())
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('k8s')
    expect(result[0].jsonSchema.properties).toBeDefined()
    expect(result[0].jsonSchema.required).toEqual(['kubeconfig'])
    expect(result[0].fieldsDoc).toBe('kubeconfig: path to kubeconfig file')
    expect(result[1].fieldsDoc).toBeUndefined()
  })

  it('degrades to [] on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    expect(await client.fetchKinds()).toEqual([])
  })

  it('degrades to [] on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await client.fetchKinds()).toEqual([])
  })
})

describe('admin API: submitEntry', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts to /ops-access/admin/entry with body containing fields', async () => {
    const mockFetch = vi.fn(async (url: string, opts: any) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }))
    vi.stubGlobal('fetch', mockFetch)

    const body = {
      kind: 'k8s',
      name: 'staging',
      tier: 'ro' as const,
      fields: { kubeconfig: '~/.kube/staging.yaml', context: 'staging' },
      description: 'Staging cluster',
      environment: 'staging',
    }
    const result = await client.submitEntry(body)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [calledUrl, calledOpts] = mockFetch.mock.calls[0]
    expect(calledUrl).toBe('/ops-access/admin/entry')
    expect(calledOpts.method).toBe('POST')
    expect(calledOpts.headers['content-type']).toBe('application/json')
    const parsedBody = JSON.parse(calledOpts.body)
    expect(parsedBody.kind).toBe('k8s')
    expect(parsedBody.name).toBe('staging')
    expect(parsedBody.tier).toBe('ro')
    expect(parsedBody.fields.kubeconfig).toBe('~/.kube/staging.yaml')
    expect(parsedBody.description).toBe('Staging cluster')
    expect(result).toEqual({ ok: true })
  })

  it('returns { ok: false, error } on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 })))
    const result = await client.submitEntry({
      kind: 'k8s', name: 'x', tier: 'ro', fields: {},
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('400')
  })

  it('returns { ok: false, error } on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const result = await client.submitEntry({
      kind: 'k8s', name: 'x', tier: 'ro', fields: {},
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('admin API: deleteEntry', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends DELETE to /ops-access/admin/entry with kind/name/tier query params', async () => {
    const mockFetch = vi.fn(async (url: string, opts: any) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.deleteEntry('k8s', 'prod', 'ro')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [calledUrl, calledOpts] = mockFetch.mock.calls[0]
    expect(calledUrl).toContain('/ops-access/admin/entry?')
    expect(calledUrl).toContain('kind=k8s')
    expect(calledUrl).toContain('name=prod')
    expect(calledUrl).toContain('tier=ro')
    expect(calledOpts.method).toBe('DELETE')
    expect(result).toEqual({ ok: true })
  })

  it('returns { ok: false, error } when entry not found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, error: 'entry not found' }),
    })))
    const result = await client.deleteEntry('ssh', 'missing', 'rw')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('entry not found')
  })

  it('returns { ok: false, error } on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const result = await client.deleteEntry('ssh', 'node-1', 'rw')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})


// ── Client half: access panel (ops-panel seam consumer, ADR-0004) ────────────

describe('access panel', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('registers the access panel and the cross-session overview when opsPanels is composed', () => {
    const { panels } = setupClient()
    expect(panels).toHaveLength(2)
    expect(panels[0]).toMatchObject({ command: 'access', title: '访问授权' })
    expect(typeof panels[0].component).toBe('function')
    // The panel seam's second consumer (ticket 13) — same registration API, no generalization needed.
    expect(panels[1]).toMatchObject({ command: 'access-all', title: '授权总览（跨会话）' })
    expect(typeof panels[1].component).toBe('function')
  })

  it('skips panel registration when opsPanels is absent (mention + admin unaffected)', () => {
    const { panels, sources, sections } = setupClient({ opsPanels: false })
    expect(panels).toHaveLength(0)
    expect(sources).toHaveLength(1)
    expect(sections).toHaveLength(1)
  })

  it('fetchPanelGrants reads the session grants and ttlOptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        ok: true,
        grants: [{ kind: 'k8s', name: 'prod', expiresAt: 1, reason: 'r', approvedBy: 'panel', remainingMinutes: 9 }],
        ttlOptions: [5, 10, 30],
      }),
    })))
    const out = await client.fetchPanelGrants('sess-1')
    expect(fetch).toHaveBeenCalledWith('/ops-access/grants?session=sess-1', expect.anything())
    expect(out?.grants).toHaveLength(1)
    expect(out?.ttlOptions).toEqual([5, 10, 30])
  })

  it('fetchPanelGrants/Requests degrade to null on 404 and network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    expect(await client.fetchPanelGrants('s')).toBeNull()
    expect(await client.fetchPanelRequests('s')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await client.fetchPanelGrants('s')).toBeNull()
    expect(await client.fetchPanelRequests('s')).toBeNull()
  })

  it('postPanelGrant posts session/kind/name/ttlMinutes', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', spy)
    const res = await client.postPanelGrant('sess-1', 'k8s', 'prod', 10)
    expect(res.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith('/ops-access/grants', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session: 'sess-1', kind: 'k8s', name: 'prod', ttlMinutes: 10 }),
    }))
  })

  it('postPanelExtend posts session/kind/name/ttlMinutes to the extend route', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', spy)
    const res = await client.postPanelExtend('sess-1', 'k8s', 'prod', 30)
    expect(res.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith('/ops-access/grants/extend', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session: 'sess-1', kind: 'k8s', name: 'prod', ttlMinutes: 30 }),
    }))
  })

  it('postPanelRevoke and postPanelRevokeAll post to their routes', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', spy)
    await client.postPanelRevoke('sess-1', 'k8s', 'prod')
    await client.postPanelRevokeAll('sess-1')
    expect(spy).toHaveBeenNthCalledWith(1, '/ops-access/grants/revoke', expect.objectContaining({
      body: JSON.stringify({ session: 'sess-1', kind: 'k8s', name: 'prod' }),
    }))
    expect(spy).toHaveBeenNthCalledWith(2, '/ops-access/grants/revoke-all', expect.objectContaining({
      body: JSON.stringify({ session: 'sess-1' }),
    }))
  })

  it('postPanelDecide includes ttlMinutes only when approving', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', spy)
    await client.postPanelDecide('gr-1', true, 5)
    await client.postPanelDecide('gr-2', false)
    expect(spy).toHaveBeenNthCalledWith(1, '/ops-access/access-requests/decide', expect.objectContaining({
      body: JSON.stringify({ id: 'gr-1', approved: true, ttlMinutes: 5 }),
    }))
    expect(spy).toHaveBeenNthCalledWith(2, '/ops-access/access-requests/decide', expect.objectContaining({
      body: JSON.stringify({ id: 'gr-2', approved: false }),
    }))
  })

  it('liveGrantFor finds the session grant covering a candidate', () => {
    const grants = [
      { kind: 'k8s', name: 'prod', expiresAt: 1, reason: 'r', approvedBy: 'panel', remainingMinutes: 9 },
    ]
    expect(client.liveGrantFor(grants, 'k8s', 'prod')).toBe(grants[0])
    expect(client.liveGrantFor(grants, 'k8s', 'staging')).toBeUndefined()
    expect(client.liveGrantFor(grants, 'ceph', 'prod')).toBeUndefined()
    expect(client.liveGrantFor([], 'k8s', 'prod')).toBeUndefined()
  })

  it('defaultTtlChoice picks the largest option not exceeding the request', () => {
    expect(client.defaultTtlChoice([5, 10, 30], 30)).toBe(30)
    expect(client.defaultTtlChoice([5, 10, 30], 45)).toBe(30)
    expect(client.defaultTtlChoice([5, 10, 30], 7)).toBe(5)
    expect(client.defaultTtlChoice([5, 10, 30], 1)).toBe(5)
  })
})

// ── Client half: degradation summary ────────────────────────────────────────

describe('degradation: 404 and network failure never throw', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('all API functions return gracefully on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    expect(await client.fetchAdminList()).toEqual([])
    expect(await client.fetchKinds()).toEqual([])
    expect((await client.submitEntry({ kind: 'k', name: 'n', tier: 'ro', fields: {} })).ok).toBe(false)
    expect((await client.deleteEntry('k', 'n', 'ro')).ok).toBe(false)
    expect(await client.fetchPanelGrants('s')).toBeNull()
    expect(await client.fetchPanelRequests('s')).toBeNull()
    expect((await client.postPanelGrant('s', 'k', 'n', 10)).ok).toBe(false)
    expect((await client.postPanelRevoke('s', 'k', 'n')).ok).toBe(false)
    expect((await client.postPanelRevokeAll('s')).ok).toBe(false)
    expect((await client.postPanelDecide('x', true, 10)).ok).toBe(false)
  })

  it('all API functions return gracefully on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    expect(await client.fetchAdminList()).toEqual([])
    expect(await client.fetchKinds()).toEqual([])
    expect((await client.submitEntry({ kind: 'k', name: 'n', tier: 'ro', fields: {} })).ok).toBe(false)
    expect((await client.deleteEntry('k', 'n', 'ro')).ok).toBe(false)
    expect(await client.fetchPanelGrants('s')).toBeNull()
    expect(await client.fetchPanelRequests('s')).toBeNull()
    expect((await client.postPanelGrant('s', 'k', 'n', 10)).ok).toBe(false)
    expect((await client.postPanelRevoke('s', 'k', 'n')).ok).toBe(false)
    expect((await client.postPanelRevokeAll('s')).ok).toBe(false)
    expect((await client.postPanelDecide('x', true, 10)).ok).toBe(false)
  })
})

// ── Pending-request badge derivation ────────────────────────────────────────

describe('pendingAccessCount', () => {
  it('counts in-flight request_access calls only — a settled call has left runningCalls', () => {
    expect(client.pendingAccessCount(undefined)).toBe(0)
    expect(client.pendingAccessCount(null)).toBe(0)
    expect(client.pendingAccessCount({})).toBe(0)
    expect(client.pendingAccessCount({ runningCalls: [] })).toBe(0)
    expect(client.pendingAccessCount({ runningCalls: [{ name: 'bash' }] })).toBe(0)
    expect(client.pendingAccessCount({ runningCalls: [{ name: 'bash' }, { name: 'request_access' }] })).toBe(1)
    expect(client.pendingAccessCount({ runningCalls: [{ name: 'request_access' }, { name: 'request_access' }] })).toBe(2)
  })
})

// ── Cross-session overview (ticket 13) ───────────────────────────────────────

describe('cross-session overview panel', () => {
  it('fetchPanelOverview maps the wire shape and degrades to null on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        ok: true,
        grants: [{ session: 'sess-b', kind: 'k8s', name: 'prod', expiresAt: 1, reason: 'r', approvedBy: 'panel', remainingMinutes: 9 }],
        requests: [{ id: 'gr-1', session: 'sess-a', kind: 'ssh', name: 'box', requestedTtlMinutes: 30, reason: 'why', createdAt: 1, decidesAt: 2 }],
        denied: [{ kind: 'ceph', name: 'main', deniedAt: 1, reason: 'freeze', deniedBy: 'panel' }],
      }),
    })))
    const data = await client.fetchPanelOverview()
    expect(fetch).toHaveBeenCalledWith('/ops-access/grants/all', expect.anything())
    expect(data?.grants[0].session).toBe('sess-b')
    expect(data?.requests[0].id).toBe('gr-1')
    expect(data?.denied[0].reason).toBe('freeze')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    expect(await client.fetchPanelOverview()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await client.fetchPanelOverview()).toBeNull()
  })

  it('groupBySession groups and sorts sessions deterministically', () => {
    const mk = (session: string, name: string): client.OverviewGrant => ({
      session, kind: 'k8s', name, expiresAt: 1, reason: 'r', approvedBy: 'panel', remainingMinutes: 5,
    })
    const groups = client.groupBySession([mk('sess-b', 'a'), mk('sess-a', 'b'), mk('sess-b', 'c')])
    expect(groups.map((g) => g.session)).toEqual(['sess-a', 'sess-b'])
    expect(groups[1].grants.map((g) => g.name)).toEqual(['a', 'c'])
    expect(client.groupBySession([])).toEqual([])
  })
})
