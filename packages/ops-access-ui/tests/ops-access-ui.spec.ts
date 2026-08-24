/**
 * ops-access-ui spec: host-half export shape (empty by design — client
 * discovery only), and the client @ source driven through mock ctx + fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as host from '../src/index.ts'
import * as client from '../src/client.ts'

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

// ── Client half ──────────────────────────────────────────────────────────────

const WIRE = [
  { kind: 'k8s', name: 'prod', description: '生产集群', environment: 'prod', mention: '@[k8s/prod](dsh-access:AAAA)' },
  { kind: 'ssh', name: 'node-1', mention: '@[ssh/node-1](dsh-access:BBBB)' },
]

function setupClient() {
  const sources: any[] = []
  const ctx: any = {
    get: (key: string) => key === 'inputTriggers'
      ? { registerSource: (s: any) => { sources.push(s); return () => {} } }
      : undefined,
    effect: (fn: () => () => void) => { fn() },
  }
  client.apply(ctx)
  return { sources, source: sources[0] }
}

describe('client @ source', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('is a function plugin with static inject on inputTriggers', () => {
    expect(client.name).toBe('ops-access-ui-client')
    expect(client.inject).toEqual(['inputTriggers'])
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
