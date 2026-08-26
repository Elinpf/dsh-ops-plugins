/**
 * Unit spec for ops-access-ssh: schema accept/reject, `~` expansion in
 * process, and registration/disposal through a mock opsAccess context.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access-ssh')
    expect(plugin.inject).toEqual([])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.provider.kind).toBe('ssh')
  })
})

// ── Schema ───────────────────────────────────────────────────────────────────

describe('entry schema', () => {
  it('accepts a minimal entry (host + user)', () => {
    expect(plugin.entrySchema.safeParse({ host: '10.0.0.11', user: 'ops' }).success).toBe(true)
  })

  it('accepts a full entry with key and port', () => {
    expect(plugin.entrySchema.safeParse({ host: '10.0.0.11', user: 'ops', key: '~/.ssh/id_ed25519', port: 22 }).success).toBe(true)
  })

  it('rejects a missing host or user', () => {
    expect(plugin.entrySchema.safeParse({ user: 'ops' }).success).toBe(false)
    expect(plugin.entrySchema.safeParse({ host: '10.0.0.11' }).success).toBe(false)
    expect(plugin.entrySchema.safeParse({ host: '10.0.0.11', user: 'ops', port: '22' }).success).toBe(false)
  })
})

// ── process ──────────────────────────────────────────────────────────────────

describe('process', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('expands ~ in key and passes host/user/port through', () => {
    process.env.HOME = '/home/tester'
    const fields = plugin.provider.process!({ host: '10.0.0.11', user: 'ops', key: '~/.ssh/id_ed25519', port: 22 }, 'node-1')
    expect(fields).toEqual({ host: '10.0.0.11', user: 'ops', key: '/home/tester/.ssh/id_ed25519', port: 22 })
  })

  it('omits optional fields when absent', () => {
    const fields = plugin.provider.process!({ host: '10.0.0.11', user: 'ops' }, 'node-1')
    expect(fields).toEqual({ host: '10.0.0.11', user: 'ops' })
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
it('carries a derivationDoc for help()', () => {
  expect(plugin.provider.derivationDoc).toContain('register_access')
})

// ── validateContent (save-time paste guard) ──────────────────────────────────

describe('validateContent', () => {
  it('accepts PEM and OpenSSH private key blocks', () => {
    expect(plugin.provider.validateContent?.('key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA=\n-----END OPENSSH PRIVATE KEY-----\n')).toBeNull()
    expect(plugin.provider.validateContent?.('key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n')).toBeNull()
  })

  it('rejects content that is not a private key', () => {
    expect(plugin.provider.validateContent?.('key', 'ssh-ed25519 AAAA... ops@host\n')).toMatch(/not a private key/)
    expect(plugin.provider.validateContent?.('key', '-----BEGIN OPENSSH PRIVATE KEY-----\ntruncated\n')).toMatch(/not a private key/)
  })

  it('ignores non-file fields', () => {
    expect(plugin.provider.validateContent?.('host', 'anything')).toBeNull()
  })
})
