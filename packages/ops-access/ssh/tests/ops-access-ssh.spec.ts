/**
 * Unit spec for ops-access-ssh: schema accept/reject, `~` expansion in
 * process, and registration/disposal through a mock opsAccess context.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import * as plugin from '../src/index.ts'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access-ssh')
    expect(plugin.inject).toEqual([])
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.provider.kind).toBe('ssh')
  })

  it('invariant companion: named exports, no default, no-op install', async () => {
    const mod = await import('../src/invariant.ts')
    expect('default' in mod).toBe(false)
    expect(mod.name).toBe('ops-access-ssh-invariant')
    expect(mod.inject).toEqual(['invariants'])
    const calls: Array<[string, () => void]> = []
    await mod.apply({ invariants: { register: (pkg: string, install: () => void) => calls.push([pkg, install]) } })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('@deepseek-ai/dsh-ops-access-ssh')
    expect(calls[0][1]()).toBeUndefined()
  })

  it('types subpath re-exports stay type-only (no runtime values leaked)', async () => {
    const mod: Record<string, unknown> = await import('../src/types.ts')
    expect('default' in mod).toBe(false)
    expect(Object.keys(mod)).toHaveLength(0)
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
  // The register mock returns a REAL disposer: it removes the provider from
  // the registry array, so HMR unload can be asserted end to end.
  function makeCtx() {
    const registered: AccessProvider[] = []
    const effectCleanups: Array<() => void> = []
    const pctx: any = {
      opsAccess: {
        register: (p: AccessProvider) => {
          registered.push(p)
          return () => {
            const i = registered.indexOf(p)
            if (i >= 0) registered.splice(i, 1)
          }
        },
      },
      effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    }
    let injectedDeps: string[] = []
    const ctx: any = {
      inject: (deps: string[], cb: (c: any) => void) => { injectedDeps = deps; cb(pctx) },
    }
    return { ctx, registered, effectCleanups, getInjectedDeps: () => injectedDeps }
  }

  it('defers through ctx.inject and registers once opsAccess arrives', () => {
    const { ctx, registered, effectCleanups, getInjectedDeps } = makeCtx()
    plugin.apply(ctx, { validateTimeoutMs: 5000 })
    expect(getInjectedDeps()).toEqual(['opsAccess'])
    expect(registered).toHaveLength(1)
    expect(registered[0].kind).toBe(plugin.provider.kind)
    expect(effectCleanups).toHaveLength(1)
  })

  it('HMR unload: running every effect disposer removes the provider from the registry', () => {
    const { ctx, registered, effectCleanups } = makeCtx()
    plugin.apply(ctx, { validateTimeoutMs: 5000 })
    expect(registered).toHaveLength(1)
    for (const dispose of effectCleanups) dispose()
    expect(registered).toHaveLength(0)
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

// ── validateContent (armor gate + REAL ssh-keygen parse) ─────────────────

describe('validateContent', () => {
  let dir: string
  let validKey: string
  let encryptedKey: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ops-ssh-spec-'))
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'plain')])
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'pw123', '-f', join(dir, 'encrypted')])
    validKey = await readFile(join(dir, 'plain'), 'utf8')
    encryptedKey = await readFile(join(dir, 'encrypted'), 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('opts into write-time trailing-newline normalization (the 2026-08-27 incident class)', () => {
    expect(plugin.provider.normalizeTrailingNewline).toBe(true)
  })

  it('accepts a real parseable private key', async () => {
    expect(await plugin.provider.validateContent?.('key', validKey)).toBeNull()
  })

  it('rejects a structurally plausible but corrupt key through the real parser', async () => {
    // armor intact, body decodes to garbage — the old regex-only check passed this
    const corrupt = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA=\n-----END OPENSSH PRIVATE KEY-----\n'
    const res = await plugin.provider.validateContent?.('key', corrupt)
    expect(res).toMatch(/ssh-keygen cannot parse this key/)
  })

  it('rejects a passphrase-protected key with a BatchMode explanation', async () => {
    const res = await plugin.provider.validateContent?.('key', encryptedKey)
    expect(res).toMatch(/passphrase/)
    expect(res).toMatch(/BatchMode/)
  })

  it('rejects content that is not a private key', async () => {
    expect(await plugin.provider.validateContent?.('key', 'ssh-ed25519 AAAA... ops@host\n')).toMatch(/not a private key/)
    expect(await plugin.provider.validateContent?.('key', '-----BEGIN OPENSSH PRIVATE KEY-----\ntruncated\n')).toMatch(/not a private key/)
  })

  it('ignores non-file fields', async () => {
    expect(await plugin.provider.validateContent?.('host', 'anything')).toBeNull()
  })
})
