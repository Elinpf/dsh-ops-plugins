/**
 * Unit spec for ops-access-ceph: schema accept/reject, `~` expansion in
 * process, and registration/disposal through a mock opsAccess context.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access-ceph')
    expect(plugin.inject).toEqual([])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.provider.kind).toBe('ceph')
  })
})

// ── Schema ───────────────────────────────────────────────────────────────────

describe('entry schema', () => {
  it('accepts a valid entry', () => {
    expect(plugin.entrySchema.safeParse({ conf: '/etc/ceph/ceph.conf', keyring: '~/.ceph/keyring' }).success).toBe(true)
  })

  it('rejects when either required path is missing', () => {
    expect(plugin.entrySchema.safeParse({ conf: '/etc/ceph/ceph.conf' }).success).toBe(false)
    expect(plugin.entrySchema.safeParse({ keyring: '/etc/ceph/keyring' }).success).toBe(false)
    expect(plugin.entrySchema.safeParse({}).success).toBe(false)
  })
})

// ── process ──────────────────────────────────────────────────────────────────

describe('process', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('expands ~ in both paths', () => {
    process.env.HOME = '/home/tester'
    const fields = plugin.provider.process!({ conf: '~/ceph/ceph.conf', keyring: '~/ceph/keyring' }, 'main')
    expect(fields).toEqual({ conf: '/home/tester/ceph/ceph.conf', keyring: '/home/tester/ceph/keyring' })
  })

  it('leaves absolute paths untouched', () => {
    const fields = plugin.provider.process!({ conf: '/etc/ceph/ceph.conf', keyring: '/etc/ceph/keyring' }, 'main')
    expect(fields).toEqual({ conf: '/etc/ceph/ceph.conf', keyring: '/etc/ceph/keyring' })
  })

  it('passes name through when present, omits it when absent', () => {
    const withName = plugin.provider.process!({ conf: '/etc/ceph/ceph.conf', keyring: '/etc/ceph/keyring', name: 'client.dsh-test' }, 'main')
    expect(withName.name).toBe('client.dsh-test')
    const without = plugin.provider.process!({ conf: '/etc/ceph/ceph.conf', keyring: '/etc/ceph/keyring' }, 'main')
    expect('name' in without).toBe(false)
  })
})

// ── Registration ─────────────────────────────────────────────────────────────

describe('apply', () => {
  it('defers through ctx.inject and registers once opsAccess arrives', () => {
    const registered: AccessProvider[] = []
    let disposed = false
    const effectCleanups: Array<() => void> = []
    const pctx: any = {
      opsAccess: {
        register: (p: AccessProvider) => {
          registered.push(p)
          return () => { disposed = true }
        },
      },
      effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    }
    let injectedDeps: string[] = []
    const ctx: any = {
      inject: (deps: string[], cb: (c: any) => void) => { injectedDeps = deps; cb(pctx) },
    }

    plugin.apply(ctx, {})
    expect(injectedDeps).toEqual(['opsAccess'])
    expect(registered).toEqual([plugin.provider])
    expect(effectCleanups).toHaveLength(1)
    effectCleanups[0]()
    expect(disposed).toBe(true)
  })
})

// fieldsDoc feeds ops-access help() — the agent-facing registry doc.
it('carries fieldsDoc for help()', () => {
  expect(typeof plugin.provider.fieldsDoc).toBe('string')
  expect(plugin.provider.fieldsDoc!.length).toBeGreaterThan(0)
})

// derivationDoc feeds help() — the ro self-registration recipe.
it('carries a derivationDoc naming convention for help()', () => {
  expect(plugin.provider.derivationDoc).toContain('client.<id>-ro')
  expect(plugin.provider.derivationDoc).toContain('register_access')
})

// ── validateContent (save-time paste guard) ──────────────────────────────────

describe('validateContent', () => {
  const KEY = 'AQDz+29q6z2lGRAA8dc0W+ygqt3belG1HVW1Pg=='
  const VALID_CONF = '[global]\nmon_host = 10.0.0.1:6789\n'
  const VALID_KEYRING = '[client.admin]\n\tkey = ' + KEY + '\n'

  it('accepts a well-formed conf and keyring', () => {
    expect(plugin.provider.validateContent?.('conf', VALID_CONF)).toBeNull()
    expect(plugin.provider.validateContent?.('keyring', VALID_KEYRING)).toBeNull()
  })

  it('no longer rejects a missing trailing newline — core normalizes it at write time', () => {
    expect(plugin.provider.normalizeTrailingNewline).toBe(true)
    expect(plugin.provider.validateContent?.('conf', VALID_CONF.trimEnd())).toBeNull()
    expect(plugin.provider.validateContent?.('keyring', VALID_KEYRING.trimEnd())).toBeNull()
  })

  it('rejects a keyring whose key line lost its indentation (paste corruption)', () => {
    const broken = '[client.admin]\nkey = ' + KEY + '\n'
    expect(plugin.provider.validateContent?.('keyring', broken)).toMatch(/no indented "key =/)
  })

  it('rejects a keyring with a non-base64 or short key', () => {
    expect(plugin.provider.validateContent?.('keyring', '[client.admin]\n\tkey = not!base64\n')).toMatch(/not valid base64/)
    expect(plugin.provider.validateContent?.('keyring', '[client.admin]\n\tkey = QUJD\n')).toMatch(/too short/)
  })

  it('rejects a conf without [global] or mon_host', () => {
    expect(plugin.provider.validateContent?.('conf', 'mon_host = 10.0.0.1\n')).toMatch(/no \[global\] section/)
    expect(plugin.provider.validateContent?.('conf', '[global]\n')).toMatch(/no mon_host/)
  })

  it('rejects a keyring without a client section', () => {
    expect(plugin.provider.validateContent?.('keyring', 'key = ' + KEY + '\n')).toMatch(/no \[client\./)
  })

  it('ignores non-file fields', () => {
    expect(plugin.provider.validateContent?.('name', 'anything')).toBeNull()
  })
})
