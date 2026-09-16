/**
 * Unit spec for the store's durability guarantees: concurrent saves never
 * share a tmp file (no ENOENT / truncation race), every save leaves a
 * readable document, and a torn audit line (crash mid-append) does not
 * poison readAudit.
 */

import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HubStore } from '../src/store.ts'
import { mktmpdir } from '@elinpf/dsh-ops-test-support/tmpdir'

function freshStore(): { store: HubStore; dir: string } {
  const dir = mktmpdir('hub-store-')
  return { store: new HubStore({ dataDir: dir }), dir }
}

describe('save', () => {
  it('survives concurrent saves without tmp-file collision', async () => {
    const { store, dir } = freshStore()
    await store.init()
    // Distinct tmp names per save: 20 parallel saves must all succeed.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        store.putTier('k8s', `p${i}`, 'ro', { fields: { v: i } })
        return store.save()
      }),
    )
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])

    const reopened = new HubStore({ dataDir: dir })
    await reopened.init()
    // Shared in-memory doc: every save carried all mutations, nothing lost.
    for (let i = 0; i < 20; i++) {
      expect(reopened.getEntry('k8s', `p${i}`)?.tiers.ro?.fields).toEqual({ v: i })
    }
  })
})

describe('readAudit', () => {
  it('skips a torn final line instead of throwing', async () => {
    const { store, dir } = freshStore()
    await store.init()
    await store.audit('admin', 'put', 'k8s', 'prod', 'ro')
    // Simulate a crash mid-append: a truncated JSON record at the tail.
    appendFileSync(join(dir, 'audit.log'), '{"ts":"2026-01-01T00:00:00.000Z","role":"adm')
    await store.audit('read', 'resolve', 'k8s', 'prod', 'ro')

    const records = await store.readAudit(10)
    expect(records.map((r) => r.action)).toEqual(['put', 'resolve'])
  })
})

describe('registration requests', () => {
  it('persists requests across a store reload', async () => {
    const { store, dir } = freshStore()
    await store.init()
    const req = store.putRequest({ kind: 'k8s', name: 'prod', tier: 'rw', fields: { kubeconfig: 'KC' }, envelope: {} })
    await store.save()

    const reopened = new HubStore({ dataDir: dir })
    await reopened.init()
    expect(reopened.getRequest(req.id)).toMatchObject({ kind: 'k8s', name: 'prod', tier: 'rw', status: 'pending' })
    expect(reopened.listRequests('pending')).toHaveLength(1)

    // Decide on the reopened store: approval writes the tier, fields are wiped.
    expect(reopened.decideRequest(req.id, true)?.status).toBe('approved')
    await reopened.save()
    expect(reopened.getEntry('k8s', 'prod')?.tiers.rw?.fields).toEqual({ kubeconfig: 'KC' })
    expect(reopened.getRequest(req.id)?.fields).toEqual({})
    expect(reopened.decideRequest(req.id, false)).toBeNull()
  })
})
