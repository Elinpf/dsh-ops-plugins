/**
 * Unit spec for ops-access-prometheus: schema accept/reject, `~` expansion
 * and trailing-slash stripping in process, the token paste guard, and
 * registration/disposal through a mock opsAccess context.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import * as types from '../src/types.ts'
import type { AccessProvider } from '@elinpf/dsh-ops-access'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access-prometheus')
    expect(plugin.inject).toEqual([])
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.provider.kind).toBe('prometheus')
  })

  it('types subpath carries zero runtime code', () => {
    expect('default' in types).toBe(false)
    expect(Object.keys(types)).toEqual([])
  })

  it('invariant subpath is a function plugin: named exports, no default', () => {
    expect('default' in invariant).toBe(false)
    expect(invariant.name).toBe('ops-access-prometheus-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(typeof invariant.apply).toBe('function')
  })

  it('invariant companion reserves package ownership, installing nothing', async () => {
    const registered: string[] = []
    await invariant.apply({ invariants: { register: (pkg: string) => { registered.push(pkg) } } })
    expect(registered).toEqual(['@elinpf/dsh-ops-access-prometheus'])
  })
})

// ── Schema ───────────────────────────────────────────────────────────────────

describe('entry schema', () => {
  it('accepts a minimal entry (url only)', () => {
    expect(plugin.entrySchema.safeParse({ url: 'http://prometheus.monitoring:9090' }).success).toBe(true)
    expect(plugin.entrySchema.safeParse({ url: 'https://prom.example.com' }).success).toBe(true)
  })

  it('accepts an optional token path', () => {
    expect(plugin.entrySchema.safeParse({ url: 'http://prom:9090', token: '~/.dsh-ops/credentials/prometheus/prod/ro/token' }).success).toBe(true)
  })

  it('rejects a missing url or a non-http(s) url', () => {
    expect(plugin.entrySchema.safeParse({}).success).toBe(false)
    expect(plugin.entrySchema.safeParse({ url: 'not-a-url' }).success).toBe(false)
    expect(plugin.entrySchema.safeParse({ url: 'ftp://prom:9090' }).success).toBe(false)
  })
})

// ── process ──────────────────────────────────────────────────────────────────

describe('process', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('expands ~ in the token path', () => {
    process.env.HOME = '/home/tester'
    const fields = plugin.provider.process!({ url: 'http://prom:9090', token: '~/tokens/prod' }, 'main')
    expect(fields.token).toBe('/home/tester/tokens/prod')
  })

  it('strips trailing slashes from the url', () => {
    const fields = plugin.provider.process!({ url: 'http://prom:9090/' }, 'main')
    expect(fields.url).toBe('http://prom:9090')
  })

  it('omits the token when absent', () => {
    const fields = plugin.provider.process!({ url: 'http://prom:9090' }, 'main')
    expect('token' in fields).toBe(false)
  })
})

// ── validateContent (save-time paste guard) ──────────────────────────────────

describe('validateContent', () => {
  it('accepts a single-line token', () => {
    expect(plugin.provider.validateContent?.('token', 'abc.def.ghi')).toBeNull()
    // core normalizes the trailing newline before validation
    expect(plugin.provider.validateContent?.('token', 'abc.def.ghi\n')).toBeNull()
  })

  it('rejects a token with an interior newline (it would corrupt the Authorization header)', () => {
    expect(plugin.provider.validateContent?.('token', 'abc\ndef\n')).toMatch(/single line/)
  })

  it('ignores non-file fields', () => {
    expect(plugin.provider.validateContent?.('url', 'anything')).toBeNull()
  })
})

// ── help() docs ──────────────────────────────────────────────────────────────

it('carries fieldsDoc for help()', () => {
  expect(typeof plugin.provider.fieldsDoc).toBe('string')
  expect(plugin.provider.fieldsDoc!.length).toBeGreaterThan(0)
})

it('declares token as the only file field and carries knownLimits', () => {
  expect(plugin.provider.fileFields).toEqual(['token'])
  expect(plugin.provider.knownLimits).toContain('read-only')
})

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Mock of the mount path registerAccessProvider walks: ctx.inject defers to a
 * parent context whose effect() collects disposers, and opsAccess.register
 * returns a disposer that REALLY removes the provider from the registry.
 */
function makeMount() {
  const registry = new Map<string, AccessProvider>()
  const effectCleanups: Array<() => void> = []
  const pctx: any = {
    opsAccess: {
      register: (p: AccessProvider) => {
        registry.set(p.kind, p)
        return () => { registry.delete(p.kind) }
      },
    },
    effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
  }
  let injectedDeps: string[] = []
  const ctx: any = {
    inject: (deps: string[], cb: (c: any) => void) => { injectedDeps = deps; cb(pctx) },
  }
  return { ctx, registry, effectCleanups, injectedDeps: () => injectedDeps }
}

describe('apply', () => {
  it('defers through ctx.inject and registers once opsAccess arrives', () => {
    const m = makeMount()
    plugin.apply(m.ctx)
    expect(m.injectedDeps()).toEqual(['opsAccess'])
    expect(m.registry.size).toBe(1)
    expect(m.registry.get('prometheus')?.kind).toBe(plugin.provider.kind)
    expect(m.effectCleanups).toHaveLength(1)
  })

  it('HMR unload: running every effect disposer removes the provider from the registry', () => {
    const m = makeMount()
    plugin.apply(m.ctx)
    expect(m.registry.has('prometheus')).toBe(true)
    for (const dispose of m.effectCleanups) dispose()
    expect(m.registry.has('prometheus')).toBe(false)
    expect(m.registry.size).toBe(0)
  })
})
