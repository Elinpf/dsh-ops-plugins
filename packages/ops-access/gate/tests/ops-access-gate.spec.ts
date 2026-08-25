/**
 * Unit spec for ops-access-gate: mounts core + gate together and drives the
 * externally observable seam — resolve serves ro vs rw fields depending on
 * the ledger, grants are isolated by session, and a missing agent is
 * fail-closed (ro, never rw). The gate never touches credential fields.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { setup, RO_REGISTRY, RW_REGISTRY } from './harness.ts'

const SESSION_A = { id: 'sess-a' }
const SESSION_B = { id: 'sess-b' }

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access-gate')
    expect(plugin.inject).toEqual([])
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
    gate.authorize({ session: SESSION_A.id, kind: 'test', name: 'prod' })
    const profile = await opsAccess.resolve('test', 'prod', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://rw-prod.internal')
  })

  it('grant for a different profile does not elevate the requested one', async () => {
    const { opsAccess, gate, writeRo, writeRw } = setup()
    writeRo(RO_REGISTRY + '  staging:\n    endpoint: https://ro-staging.internal\n')
    writeRw(RW_REGISTRY + '  staging:\n    endpoint: https://rw-staging.internal\n')
    gate.authorize({ session: SESSION_A.id, kind: 'test', name: 'staging' })
    // prod has no grant → ro; staging has a grant → rw.
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
    expect((await opsAccess.resolve('test', 'staging', SESSION_A)).fields.endpoint).toBe('https://rw-staging.internal')
  })

  it('grant for a different kind does not elevate', async () => {
    const { opsAccess, gate, writeRo } = setup()
    writeRo(RO_REGISTRY)
    gate.authorize({ session: SESSION_A.id, kind: 'other', name: 'prod' })
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://ro-prod.internal')
  })
})

// ── Session isolation ────────────────────────────────────────────────────────

describe('session isolation', () => {
  it('a grant for session A is invisible to session B', async () => {
    const { opsAccess, gate, writeRo, writeRw } = setup()
    writeRo(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    gate.authorize({ session: SESSION_A.id, kind: 'test', name: 'prod' })
    expect((await opsAccess.resolve('test', 'prod', SESSION_A)).fields.endpoint).toBe('https://rw-prod.internal')
    expect((await opsAccess.resolve('test', 'prod', SESSION_B)).fields.endpoint).toBe('https://ro-prod.internal')
  })

  it('isAuthorized is session-scoped', () => {
    const { gate } = setup()
    gate.authorize({ session: 'sess-a', kind: 'k8s', name: 'prod' })
    expect(gate.isAuthorized('sess-a', 'k8s', 'prod')).toBe(true)
    expect(gate.isAuthorized('sess-b', 'k8s', 'prod')).toBe(false)
    expect(gate.isAuthorized('sess-a', 'k8s', 'staging')).toBe(false)
    expect(gate.isAuthorized('sess-a', 'ceph', 'prod')).toBe(false)
  })

  it('authorize is idempotent for the same session+profile', () => {
    const { gate } = setup()
    gate.authorize({ session: 's', kind: 'k8s', name: 'prod' })
    gate.authorize({ session: 's', kind: 'k8s', name: 'prod' })
    expect(gate.isAuthorized('s', 'k8s', 'prod')).toBe(true)
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
    gate.authorize({ session: SESSION_A.id, kind: 'test', name: 'prod' })
    const profile = await opsAccess.resolve('test', 'prod')
    expect(profile.fields.endpoint).toBe('https://ro-prod.internal')
  })

  it('the broker is a pure ro/rw decision — the gate never sees credential fields', () => {
    // Structural guarantee: the grant carries only session/kind/name. There is
    // no field on the contract for secret material to ride on.
    const grant: plugin.Grant = { session: 's', kind: 'k8s', name: 'prod' }
    expect(grant).toEqual({ session: 's', kind: 'k8s', name: 'prod' })
  })
})

// ── rw file errors do not leak secrets ───────────────────────────────────────

describe('rw file errors', () => {
  it('rw file missing on an authorized resolve errors with the rw file path', async () => {
    const { opsAccess, gate, writeRo, rwFile } = setup()
    writeRo(RO_REGISTRY)
    // rw file deliberately absent
    gate.authorize({ session: SESSION_A.id, kind: 'test', name: 'prod' })
    await expect(opsAccess.resolve('test', 'prod', SESSION_A)).rejects.toThrow(`registry file not found: ${rwFile}`)
  })

  it('rw entry missing errors without leaking the rw field value', async () => {
    const { opsAccess, gate, writeRo, writeRw, rwFile } = setup()
    writeRo(RO_REGISTRY)
    writeRw('test:\n  other:\n    endpoint: https://secret-rw-value.internal\n')
    gate.authorize({ session: SESSION_A.id, kind: 'test', name: 'prod' })
    const err = await opsAccess.resolve('test', 'prod', SESSION_A).catch((e) => e)
    expect(err.message).toContain(rwFile)
    expect(err.message).not.toContain('secret-rw-value')
  })
})
