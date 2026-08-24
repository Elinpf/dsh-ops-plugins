/**
 * Unit spec for ops-access: drives the real plugin through a mock context,
 * covering register/dispose, resolve/list against a real tmp registry file,
 * error discipline (unknown kind/name, YAML and schema failures), the
 * no-caching guarantee, and `~` expansion of registryFile.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z as zod } from 'zod'
import * as plugin from '../src/index.ts'
import type { AccessProvider } from '../src/index.ts'
import { setup } from './harness.ts'
import { decodeAccessReferenceUri, formatAccessMention } from '../src/mention.ts'

// ── Fixture provider ─────────────────────────────────────────────────────────

const testProvider: AccessProvider = {
  kind: 'test',
  schema: zod.object({ endpoint: zod.string() }),
  process: (entry, name) => ({ ...(entry as Record<string, unknown>), processedName: name }),
}

const VALID_REGISTRY = `\
version: 1
test:
  alpha:
    endpoint: https://alpha.internal
    description: alpha 环境
    environment: staging
  beta:
    endpoint: https://beta.internal
`

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access')
    expect(plugin.inject).toEqual([])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeDefined()
  })
})

// ── registerAccessProvider ───────────────────────────────────────────────────

describe('registerAccessProvider', () => {
  it('defers through ctx.inject on opsAccess and ties registration to the effect lifecycle', () => {
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

    plugin.registerAccessProvider(ctx, testProvider)
    expect(injectedDeps).toEqual(['opsAccess'])
    expect(registered).toEqual([testProvider])
    expect(effectCleanups).toHaveLength(1)
    effectCleanups[0]()
    expect(disposed).toBe(true)
  })
})

// ── register / dispose ───────────────────────────────────────────────────────

describe('register', () => {
  it('registers a provider and disposes it via the returned function', () => {
    const { handle } = setup()
    const dispose = handle.register(testProvider)
    expect(() => handle.register(testProvider)).toThrow(/already registered/)
    dispose()
    // After dispose the kind is gone; re-registering works again.
    expect(() => handle.register(testProvider)).not.toThrow()
  })
})

// ── resolve ──────────────────────────────────────────────────────────────────

describe('resolve', () => {
  it('resolves a profile: schema-validated fields, process applied, envelope fields passed through', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)

    const profile = await handle.resolve('test', 'alpha')
    expect(profile).toEqual({
      kind: 'test',
      name: 'alpha',
      description: 'alpha 环境',
      environment: 'staging',
      fields: { endpoint: 'https://alpha.internal', processedName: 'alpha' },
    })
  })

  it('throws on unknown kind', async () => {
    const { handle, write } = setup()
    write(VALID_REGISTRY)
    await expect(handle.resolve('nope', 'alpha')).rejects.toThrow(/unknown kind "nope"/)
  })

  it('throws on unknown name, listing the available names for that kind', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    await expect(handle.resolve('test', 'gamma')).rejects.toThrow(/available: alpha, beta/)
  })

  it('throws with the file path when the registry file does not exist', async () => {
    const { handle, registryFile } = setup()
    handle.register(testProvider)
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(`registry file not found: ${registryFile}`)
  })

  it('throws with the file path on YAML syntax errors, without leaking file text', async () => {
    const { handle, write, registryFile } = setup()
    handle.register(testProvider)
    write('test: [unclosed')
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(`failed to parse registry file ${registryFile}`)
  })

  it('throws with file path, entry location, and issue summary on schema validation failure', async () => {
    const { handle, write, registryFile } = setup()
    handle.register(testProvider)
    write('test:\n  alpha:\n    wrong: 1\n')
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(
      new RegExp(`invalid entry test\\.alpha in registry file ${registryFile.replace(/[/.]/g, '\\$&')}.*endpoint`),
    )
  })

  it('re-reads the file on every call — edits take effect immediately', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write('test:\n  alpha:\n    endpoint: https://v1.internal\n')
    const first = await handle.resolve('test', 'alpha')
    expect(first.fields.endpoint).toBe('https://v1.internal')

    write('test:\n  alpha:\n    endpoint: https://v2.internal\n')
    const second = await handle.resolve('test', 'alpha')
    expect(second.fields.endpoint).toBe('https://v2.internal')
  })
})

// ── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('returns an empty list when the registry file does not exist', async () => {
    const { handle } = setup()
    handle.register(testProvider)
    await expect(handle.list()).resolves.toEqual([])
  })

  it('lists all profiles with fields, skipping kinds without a registered provider', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY + 'unregistered:\n  x:\n    whatever: 1\n')

    const profiles = await handle.list()
    expect(profiles.map((p) => p.name).sort()).toEqual(['alpha', 'beta'])
    const beta = profiles.find((p) => p.name === 'beta')!
    expect(beta.description).toBeUndefined()
    expect(beta.fields).toEqual({ endpoint: 'https://beta.internal', processedName: 'beta' })
  })
})

// ── registryFile ~ expansion ─────────────────────────────────────────────────

describe('registryFile', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('expands a leading ~ to $HOME', async () => {
    // HOME must be set before apply — registryFile is expanded once at mount.
    const dir = mkdtempSync(join(tmpdir(), 'ops-access-home-'))
    process.env.HOME = dir
    const { handle } = setup({ registryFile: '~/access.yaml' })
    handle.register(testProvider)
    writeFileSync(join(dir, 'access.yaml'), VALID_REGISTRY)
    const profile = await handle.resolve('test', 'beta')
    expect(profile.fields.endpoint).toBe('https://beta.internal')
  })
})

// ── help ─────────────────────────────────────────────────────────────────────

describe('help', () => {
  it('composes the management doc: file path, format, envelope fields, per-kind docs', () => {
    const { handle, registryFile } = setup()
    handle.register({ ...testProvider, fieldsDoc: 'endpoint: the service URL' })
    const text = handle.help()
    expect(text).toContain(`File: ${registryFile}`)
    expect(text).toContain('version: 1')
    expect(text).toContain('description:')
    expect(text).toContain('environment:')
    expect(text).toContain('- test: endpoint: the service URL')
    expect(text).toContain('Re-read')
  })

  it('sorts kinds and marks providers without fieldsDoc', () => {
    const { handle } = setup()
    handle.register({ kind: 'beta', schema: zod.object({}) })
    handle.register({ kind: 'alpha', schema: zod.object({}), fieldsDoc: 'x: y' })
    const text = handle.help()
    const alphaIdx = text.indexOf('- alpha: x: y')
    const betaIdx = text.indexOf('- beta: (no field docs')
    expect(alphaIdx).toBeGreaterThan(-1)
    expect(betaIdx).toBeGreaterThan(alphaIdx)
  })

  it('no providers registered: explicit empty marker', () => {
    const { handle } = setup()
    expect(handle.help()).toContain('- (none registered)')
  })
})

// ── mention injection (agent/pre-step) ───────────────────────────────────────

describe('mention injection', () => {
  async function drivePreStep(h: ReturnType<typeof setup>, messages: any[]) {
    const entry = h.listeners.find((l) => l.event === 'agent/pre-step')
    expect(entry).toBeDefined()
    return entry!.listener(
      { agent: { id: 'a1' } },
      async () => ({ kind: 'enter', messages }),
    )
  }

  function textMessage(text: string, sourceKind = 'user') {
    return { source: { kind: sourceKind }, content: [{ type: 'text', text }] }
  }

  it('registers one prepended agent/pre-step listener', () => {
    const h = setup()
    const entries = h.listeners.filter((l) => l.event === 'agent/pre-step')
    expect(entries).toHaveLength(1)
    expect(entries[0].options).toEqual({ prepend: true })
  })

  it('rewrites mentions to readable text and injects envelope context after the citing message', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const mention = formatAccessMention({ kind: 'test', name: 'alpha' })
    const decision: any = await drivePreStep(h, [textMessage(`看看 ${mention} 怎么了`)])
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    // Direct message: readable text, mention span gone.
    expect(decision.messages[0].content[0].text).toBe('看看 @test/alpha 怎么了')
    // Injected context: envelope only — never fields.
    const injected = decision.messages[1].content[0].text
    expect(injected).toContain('<referenced-access>')
    expect(injected).toContain('- test/alpha [staging] — alpha 环境')
    expect(injected).not.toContain('endpoint')
    expect(injected).not.toContain('https://alpha.internal')
  })

  it('unknown profile degrades to a note, not an error', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const mention = formatAccessMention({ kind: 'test', name: 'ghost' })
    const decision: any = await drivePreStep(h, [textMessage(`看 ${mention}`)])
    expect(decision.messages[1].content[0].text).toContain('- test/ghost — (not found')
  })

  it('deduplicates repeated mentions of the same profile', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const mention = formatAccessMention({ kind: 'test', name: 'beta' })
    const decision: any = await drivePreStep(h, [textMessage(`${mention} 还有 ${mention}`)])
    const injected = decision.messages[1].content[0].text
    expect(injected.match(/- test\/beta/g)).toHaveLength(1)
  })

  it('leaves messages without mentions and non-user sources untouched', async () => {
    const h = setup()
    h.handle.register(testProvider)
    const plain = textMessage('没有 mention')
    const pluginMsg = textMessage(formatAccessMention({ kind: 'test', name: 'alpha' }), 'plugin')
    const decision: any = await drivePreStep(h, [plain, pluginMsg])
    expect(decision.messages).toEqual([plain, pluginMsg])
  })

  it('passes a reject decision through untouched', async () => {
    const h = setup()
    const entry = h.listeners.find((l) => l.event === 'agent/pre-step')!
    const reject = { kind: 'reject', reason: 'nope' }
    const result = await entry.listener({ agent: {} }, async () => reject)
    expect(result).toBe(reject)
  })
})

// ── mention candidate route (GET /ops-access/list) ───────────────────────────

describe('mention candidate route', () => {
  it('serves envelope-only candidates with decodable mentions', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.listRoute()
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    const alpha = body.find((c: any) => c.name === 'alpha')
    expect(alpha).toMatchObject({ kind: 'test', description: 'alpha 环境', environment: 'staging' })
    // Envelope only — no fields anywhere.
    const json = JSON.stringify(body)
    expect(json).not.toContain('endpoint')
    expect(json).not.toContain('https://alpha.internal')
    // Mentions decode back to the same kind/name.
    for (const c of body) {
      const uri = c.mention.match(/\((dsh-access:[^)]+)\)/)?.[1]
      expect(decodeAccessReferenceUri(uri!)).toEqual({ kind: c.kind, name: c.name })
    }
  })

  it('filters by query against kind/name and description', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    expect((await h.listRoute('alpha')).body.map((c: any) => c.name)).toEqual(['alpha'])
    expect((await h.listRoute('BETA')).body.map((c: any) => c.name)).toEqual(['beta'])
    expect((await h.listRoute('环境')).body.map((c: any) => c.name)).toEqual(['alpha'])
    expect((await h.listRoute('zzz')).body).toEqual([])
  })

  it('serves an empty list when the registry file does not exist', async () => {
    const h = setup()
    h.handle.register(testProvider)
    const { status, body } = await h.listRoute()
    expect(status).toBe(200)
    expect(body).toEqual([])
  })
})
