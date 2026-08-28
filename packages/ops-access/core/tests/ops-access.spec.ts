/**
 * Unit spec for ops-access: drives the real plugin through a mock context,
 * covering register/dispose, resolve/list against a real tmp registry file,
 * error discipline (unknown kind/name, YAML and schema failures), the
 * no-caching guarantee, and `~` expansion of registryFile.
 *
 * The registry is a SINGLE file; each entry carries envelope fields
 * (description/environment) at entry level and provider fields under `ro:` and
 * `rw:` tier sub-objects. `write()` writes a raw doc to the file; `writeRw()`
 * merges an rw overlay into the same file.
 */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

const VALID_REGISTRY = `version: 1
test:
  alpha:
    description: alpha 环境
    environment: staging
    ro:
      endpoint: https://alpha.internal
  beta:
    ro:
      endpoint: https://beta.internal
`

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access')
    expect(plugin.inject).toEqual(['tools'])
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
      tier: 'ro',
      description: 'alpha 环境',
      environment: 'staging',
      fields: { endpoint: 'https://alpha.internal', processedName: 'alpha' },
    })
  })

  it('resolve reports the tier the broker issued (rw on a grant)', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(`version: 1
test:
  alpha:
    ro:
      endpoint: https://alpha.internal
    rw:
      endpoint: https://alpha-rw.internal
`)
    handle.registerBroker(() => 'rw')

    const profile = await handle.resolve('test', 'alpha')
    expect(profile.tier).toBe('rw')
    expect(profile.fields).toMatchObject({ endpoint: 'https://alpha-rw.internal' })
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
    write('test:\n  alpha:\n    ro:\n      wrong: 1\n')
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(
      new RegExp(`invalid entry test\\.alpha in registry file ${registryFile.replace(/[/.]/g, '\\$&')}.*endpoint`),
    )
  })

  it('re-reads the file on every call — edits take effect immediately', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write('test:\n  alpha:\n    ro:\n      endpoint: https://v1.internal\n')
    const first = await handle.resolve('test', 'alpha')
    expect(first.fields.endpoint).toBe('https://v1.internal')

    write('test:\n  alpha:\n    ro:\n      endpoint: https://v2.internal\n')
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

  it('rw-only entries render with a derivation note instead of not-found', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(`version: 1
test:
  rwonly:
    environment: prod
    rw:
      endpoint: https://rw-only.internal
`)

    const mention = formatAccessMention({ kind: 'test', name: 'rwonly' })
    const decision: any = await drivePreStep(h, [textMessage(`看 ${mention}`)])
    const injected = decision.messages[1].content[0].text
    expect(injected).toContain('- test/rwonly [prod] (no ro tier registered yet')
    expect(injected).toContain('register_access')
    expect(injected).not.toContain('not found')
    // fields never cross
    expect(injected).not.toContain('rw-only.internal')
  })

  it('unknown profile degrades to a note, not an error', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const mention = formatAccessMention({ kind: 'test', name: 'ghost' })
    const decision: any = await drivePreStep(h, [textMessage(`看 ${mention}`)])
    expect(decision.messages[1].content[0].text).toContain('- test/ghost — (not found')
  })

  it('mention rendering never consults the broker — metadata display needs no grant', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    // A deny-everything broker (the gate's posture for approval-required
    // kinds): envelope rendering must still work, and the broker must not run.
    let consulted = 0
    h.handle.registerBroker(() => { consulted++; return { deny: 'nope' } })
    const mention = formatAccessMention({ kind: 'test', name: 'alpha' })
    const decision: any = await drivePreStep(h, [textMessage(`看 ${mention}`)])
    expect(decision.messages[1].content[0].text).toContain('- test/alpha [staging] — alpha 环境')
    expect(consulted).toBe(0)
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

// ── broker + rw registry ─────────────────────────────────────────────────────

// Two tier values with distinct endpoints so the resolved tier is observable
// in the resolved profile. ro and rw live as sub-objects of one entry in the
// single registry file.
const RO_REGISTRY = `version: 1
test:
  alpha:
    ro:
      endpoint: https://ro-alpha.internal
`
const RW_REGISTRY = `version: 1
test:
  alpha:
    rw:
      endpoint: https://rw-alpha.internal
`

const SESSION_A = { id: 'sess-a' }
const SESSION_B = { id: 'sess-b' }

describe('broker + rw registry', () => {
  it('with no broker registered, resolve is unchanged — fields come from the ro tier', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    // Even with an agent context, no broker means no escalation path.
    const profile = await handle.resolve('test', 'alpha', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://ro-alpha.internal')
  })

  it("broker 'rw' decision serves fields from the rw tier, not the ro tier", async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    handle.registerBroker(() => 'rw')
    const profile = await handle.resolve('test', 'alpha', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://rw-alpha.internal')
  })

  it("broker 'ro' decision serves fields from the ro tier", async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    handle.registerBroker(() => 'ro')
    const profile = await handle.resolve('test', 'alpha', SESSION_A)
    expect(profile.fields.endpoint).toBe('https://ro-alpha.internal')
  })

  it('broker is consulted even without an agent — the no-agent ruling belongs to the broker', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    const seen: unknown[] = []
    handle.registerBroker((_kind, _name, agent) => { seen.push(agent); return 'rw' })
    const profile = await handle.resolve('test', 'alpha') // no agent supplied
    expect(seen).toEqual([undefined])
    expect(profile.fields.endpoint).toBe('https://rw-alpha.internal')
  })

  it("a broker's deny on a no-agent call throws — core never silently falls back to ro", async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    handle.registerBroker((_kind, _name, agent) => agent ? 'ro' : { deny: 'no session, no credential' })
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow('ops-access: access denied for test/alpha: no session, no credential')
  })

  it('broker receives kind, name, and the agent', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    const seen: Array<{ kind: string, name: string, agent: unknown }> = []
    handle.registerBroker((kind, name, agent) => { seen.push({ kind, name, agent }); return 'ro' })
    await handle.resolve('test', 'alpha', SESSION_A)
    expect(seen).toEqual([{ kind: 'test', name: 'alpha', agent: SESSION_A }])
  })

  it("broker 'deny' decision throws the broker's message verbatim (broker owns the guidance)", async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    handle.registerBroker(() => ({ deny: 'no active grant — call request_access' }))
    await expect(handle.resolve('test', 'alpha', SESSION_A)).rejects.toThrow('ops-access: access denied for test/alpha: no active grant — call request_access')
  })

  it('rw-tier miss says the grant was approved but no rw credential is registered', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    // alpha has ro but no rw tier (the rw overlay lands on a different name).
    writeRw(RW_REGISTRY.replace('alpha', 'other'))
    handle.registerBroker(() => 'rw')
    const err = await handle.resolve('test', 'alpha', SESSION_A).catch((e) => e)
    expect(err.message).toMatch(/no rw tier for profile "alpha"/)
    expect(err.message).toContain('no rw credential is registered')
  })

  it('registerBroker disposes: after dispose, escalation is gone', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    const dispose = handle.registerBroker(() => 'rw')
    expect((await handle.resolve('test', 'alpha', SESSION_A)).fields.endpoint).toBe('https://rw-alpha.internal')
    dispose()
    expect((await handle.resolve('test', 'alpha', SESSION_A)).fields.endpoint).toBe('https://ro-alpha.internal')
  })

  it('a replacement broker overrides the earlier one; disposing the new one clears escalation (old disposer stays inert)', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    // Register broker A (ro-only), then replace it with B (rw). The new broker
    // governs; disposing B must fall back to ro even though A's disposer was
    // never called — B's disposal folds in the prior registration's cleanup.
    handle.registerBroker(() => 'ro')
    const disposeB = handle.registerBroker(() => 'rw')
    expect((await handle.resolve('test', 'alpha', SESSION_A)).fields.endpoint).toBe('https://rw-alpha.internal')
    disposeB()
    // After the active broker is disposed, no broker is active → ro.
    expect((await handle.resolve('test', 'alpha', SESSION_A)).fields.endpoint).toBe('https://ro-alpha.internal')
  })

  it('registry file missing on an rw decision errors with the registry file path, no secret leak', async () => {
    const { handle, registryFile } = setup()
    handle.register(testProvider)
    // registry file deliberately not written
    handle.registerBroker(() => 'rw')
    await expect(handle.resolve('test', 'alpha', SESSION_A)).rejects.toThrow(`registry file not found: ${registryFile}`)
  })

  it('rw tier missing errors with the no-rw-tier message, without leaking field values', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    // alpha has ro; the rw overlay lands on beta only — alpha's rw tier is absent.
    writeRw('test:\n  beta:\n    rw:\n      endpoint: https://rw-beta.internal\n')
    handle.registerBroker(() => 'rw')
    await expect(handle.resolve('test', 'alpha', SESSION_A)).rejects.toThrow(/no rw tier for profile "alpha"/)
  })

  it('rw schema validation failure errors with location + issue, no field value leaked', async () => {
    const { handle, write, writeRw, registryFile } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    // `endpoint` is the wrong type (fails validation); `note` carries a
    // secret value that the provider schema strips — it must never appear in
    // the thrown error.
    writeRw('test:\n  alpha:\n    rw:\n      endpoint: 5\n      note: secret-value\n')
    handle.registerBroker(() => 'rw')
    const err = await handle.resolve('test', 'alpha', SESSION_A).catch((e) => e)
    expect(err.message).toMatch(new RegExp(`invalid entry test\\.alpha in registry file ${registryFile.replace(/[/.]/g, '\\$&')}`))
    expect(err.message).toMatch(/endpoint/)
    // The stripped field value must not leak into the error.
    expect(err.message).not.toContain('secret-value')
  })

  it('YAML syntax error errors with the registry file path, no file text leaked', async () => {
    const { handle, write, registryFile } = setup()
    handle.register(testProvider)
    write('test: [unclosed')
    handle.registerBroker(() => 'rw')
    await expect(handle.resolve('test', 'alpha', SESSION_A)).rejects.toThrow(`failed to parse registry file ${registryFile}`)
  })

  it('list only surfaces the ro tier — rw-only profiles never appear', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw('test:\n  beta:\n    rw:\n      endpoint: https://rw-beta.internal\n')
    const profiles = await handle.list()
    expect(profiles.map((p) => p.name)).toEqual(['alpha'])
    expect(JSON.stringify(profiles)).not.toContain('rw-beta')
  })
})

// ── canResolve ───────────────────────────────────────────────────────────────

describe('canResolve', () => {
  it('checks the chosen tier: existence AND provider-schema validity, returning { ok, error? }', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    expect(await handle.canResolve('test', 'alpha', 'ro')).toEqual({ ok: true })
    expect(await handle.canResolve('test', 'alpha', 'rw')).toEqual({ ok: true })
    expect(await handle.canResolve('test', 'ghost', 'ro')).toEqual({ ok: false })
    expect(await handle.canResolve('ghost', 'alpha', 'ro')).toEqual({ ok: false }) // unknown kind
  })

  it('a schema-invalid entry is NOT resolvable — the precheck is as deep as real issuance', async () => {
    const { handle, writeRw } = setup()
    handle.register(testProvider)
    writeRw('test:\n  alpha:\n    rw:\n      endpoint: 5\n')
    const result = await handle.canResolve('test', 'alpha', 'rw')
    expect(result).toEqual({ ok: false, error: expect.any(String) })
    // The error surfaces the failing field, never raw field values.
    expect(result.error).toMatch(/endpoint/)
  })

  it('a missing registry file means nothing resolves from that tier', async () => {
    const { handle } = setup()
    handle.register(testProvider)
    expect(await handle.canResolve('test', 'alpha', 'rw')).toEqual({ ok: false })
  })

  it('an unparseable registry file means nothing resolves from that tier (no throw)', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write('test: [unclosed')
    expect(await handle.canResolve('test', 'alpha', 'rw')).toEqual({ ok: false })
  })

  it('never consults the broker — it is a metadata query, not issuance', async () => {
    const { handle, writeRw } = setup()
    handle.register(testProvider)
    writeRw(RW_REGISTRY)
    let consulted = 0
    handle.registerBroker(() => { consulted++; return 'rw' })
    expect(await handle.canResolve('test', 'alpha', 'rw')).toEqual({ ok: true })
    expect(consulted).toBe(0)
  })
})

// ── registerAccessBroker ─────────────────────────────────────────────────────

describe('registerAccessBroker', () => {
  it('defers through ctx.inject on opsAccess and ties registration to the effect lifecycle', () => {
    const registered: Array<(kind: string, name: string, agent: { id: string }) => unknown> = []
    let disposed = false
    const effectCleanups: Array<() => void> = []
    const pctx: any = {
      opsAccess: {
        registerBroker: (b: any) => { registered.push(b); return () => { disposed = true } },
      },
      effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    }
    let injectedDeps: string[] = []
    const ctx: any = {
      inject: (deps: string[], cb: (c: any) => void) => { injectedDeps = deps; cb(pctx) },
    }

    const broker = () => 'ro' as const
    plugin.registerAccessBroker(ctx, broker)
    expect(injectedDeps).toEqual(['opsAccess'])
    expect(registered).toEqual([broker])
    expect(effectCleanups).toHaveLength(1)
    effectCleanups[0]()
    expect(disposed).toBe(true)
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

// ── writeEntry ───────────────────────────────────────────────────────────────

describe('writeEntry', () => {
  it('rejects profile names that are unsafe as ids (paths, mention syntax)', async () => {
    const { handle, write, registryFile } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    const original = readFileSync(registryFile, 'utf8')
    for (const bad of ['../escape', 'a/b', 'has space', '.hidden', '-leading', '']) {
      await expect(handle.writeEntry('test', bad, 'ro', { endpoint: 'https://x.internal' }))
        .rejects.toThrow(/invalid profile name/)
    }
    // Nothing was written.
    expect(readFileSync(registryFile, 'utf8')).toBe(original)
  })

  it('accepts ids with the allowed punctuation (@ . _ -)', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    await handle.writeEntry('test', 'kubernetes-admin@kubernetes', 'ro', { endpoint: 'https://x.internal' })
    const profile = await handle.resolve('test', 'kubernetes-admin@kubernetes')
    expect(profile.fields.endpoint).toBe('https://x.internal')
  })

  it('empty-string envelope fields clear the existing value (omitted preserves)', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    // Set a display name + description first.
    await handle.writeEntry('test', 'alpha', 'ro', { endpoint: 'https://alpha.internal' }, { name: '旧名称', description: '旧描述' })
    let profile = await handle.resolve('test', 'alpha')
    expect(profile.displayName).toBe('旧名称')
    expect(profile.description).toBe('旧描述')
    // Clear the display name with an empty string; omit description (preserved).
    await handle.writeEntry('test', 'alpha', 'ro', { endpoint: 'https://alpha.internal' }, { name: '' })
    profile = await handle.resolve('test', 'alpha')
    expect(profile.displayName).toBeUndefined()
    expect(profile.description).toBe('旧描述')
    expect(profile.environment).toBe('staging')
  })

  it('stores the envelope display name and surfaces it as displayName', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    await handle.writeEntry('test', 'gamma', 'ro', { endpoint: 'https://gamma.internal' }, { name: '生产集群 γ' })
    const profile = await handle.resolve('test', 'gamma')
    expect(profile.name).toBe('gamma')
    expect(profile.displayName).toBe('生产集群 γ')
    // And it reads back through getEntry.
    const entry = await handle.getEntry('test', 'gamma', 'ro')
    expect(entry?.displayName).toBe('生产集群 γ')
  })

  it('upserts a new entry → resolve can get it', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    await handle.writeEntry('test', 'gamma', 'ro', { endpoint: 'https://gamma.internal' }, { description: 'gamma env' })
    const profile = await handle.resolve('test', 'gamma')
    expect(profile.fields.endpoint).toBe('https://gamma.internal')
    expect(profile.description).toBe('gamma env')
  })

  it('overwrites an existing tier → old tier value is replaced, envelope preserved', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    await handle.writeEntry('test', 'alpha', 'ro', { endpoint: 'https://new-alpha.internal' })
    const profile = await handle.resolve('test', 'alpha')
    expect(profile.fields.endpoint).toBe('https://new-alpha.internal')
    // writeEntry replaces only the tier sub-object; envelope fields on the
    // parent entry are left untouched when no envelope is passed.
    expect(profile.description).toBe('alpha 环境')
    expect(profile.environment).toBe('staging')
  })

  it('schema failure → does not write the file and throws', async () => {
    const { handle, write, registryFile } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    const original = readFileSync(registryFile, 'utf8')
    await expect(handle.writeEntry('test', 'alpha', 'ro', { wrong: 1 })).rejects.toThrow(/endpoint/)
    // File is untouched.
    expect(readFileSync(registryFile, 'utf8')).toBe(original)
  })

  it('creates the registry file when it does not exist', async () => {
    const { handle, registryFile } = setup()
    handle.register(testProvider)
    // registry file deliberately not written
    await handle.writeEntry('test', 'alpha', 'rw', { endpoint: 'https://rw-alpha.internal' })
    const profile = await handle.canResolve('test', 'alpha', 'rw')
    expect(profile).toEqual({ ok: true })
    // File now exists and was written.
    const text = readFileSync(registryFile, 'utf8')
    expect(text).toContain('version: 1')
    expect(text).toContain('https://rw-alpha.internal')
  })

  it('throws on unknown kind', async () => {
    const { handle } = setup()
    handle.register(testProvider)
    await expect(handle.writeEntry('nope', 'alpha', 'ro', { endpoint: 'x' })).rejects.toThrow(/unknown kind "nope"/)
  })

  it('preserves other entries in the file when writing one', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    await handle.writeEntry('test', 'gamma', 'ro', { endpoint: 'https://gamma.internal' })
    // alpha and beta are still there.
    const alpha = await handle.resolve('test', 'alpha')
    expect(alpha.fields.endpoint).toBe('https://alpha.internal')
    const beta = await handle.resolve('test', 'beta')
    expect(beta.fields.endpoint).toBe('https://beta.internal')
  })

  it('writes envelope fields alongside provider fields', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    await handle.writeEntry('test', 'gamma', 'ro',
      { endpoint: 'https://gamma.internal' },
      { description: 'gamma desc', environment: 'gamma-env' })
    const profile = await handle.resolve('test', 'gamma')
    expect(profile.description).toBe('gamma desc')
    expect(profile.environment).toBe('gamma-env')
    expect(profile.fields.endpoint).toBe('https://gamma.internal')
  })
})

// ── deleteEntry ──────────────────────────────────────────────────────────────

describe('deleteEntry', () => {
  it('deletes an existing entry → resolve throws not found', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    const deleted = await handle.deleteEntry('test', 'alpha', 'ro')
    expect(deleted).toBe(true)
    await expect(handle.resolve('test', 'alpha')).rejects.toThrow(/no profile "alpha"/)
    // Other entries survive.
    const beta = await handle.resolve('test', 'beta')
    expect(beta.fields.endpoint).toBe('https://beta.internal')
  })

  it('deleting a non-existent entry → returns false', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    const deleted = await handle.deleteEntry('test', 'ghost', 'ro')
    expect(deleted).toBe(false)
  })

  it('file does not exist → returns false', async () => {
    const { handle } = setup()
    handle.register(testProvider)
    const deleted = await handle.deleteEntry('test', 'alpha', 'rw')
    expect(deleted).toBe(false)
  })

  it('deletes from the rw tier independently of ro', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    const deleted = await handle.deleteEntry('test', 'alpha', 'rw')
    expect(deleted).toBe(true)
    // ro entry is untouched.
    const profile = await handle.resolve('test', 'alpha')
    expect(profile.fields.endpoint).toBe('https://ro-alpha.internal')
  })
})

// ── listAll ──────────────────────────────────────────────────────────────────

describe('listAll', () => {
  it('envelope carries the display name through to the admin view', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write('test:\n  alpha:\n    name: 生产集群\n    ro:\n      endpoint: https://alpha.internal\n')
    const entries = await handle.listAll()
    const alpha = entries.find((e) => e.kind === 'test' && e.name === 'alpha')!
    expect(alpha.envelope.name).toBe('生产集群')
  })

  it('ro has rw does not → ro.ok=true rw.ok=false', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    const entries = await handle.listAll()
    const alpha = entries.find((e) => e.kind === 'test' && e.name === 'alpha')!
    expect(alpha.tiers.ro).toEqual({ ok: true })
    expect(alpha.tiers.rw).toEqual({ ok: false })
  })

  it('schema failure → ok=false with error carrying the reason', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write('test:\n  alpha:\n    ro:\n      endpoint: 5\n')
    const entries = await handle.listAll()
    const alpha = entries.find((e) => e.kind === 'test' && e.name === 'alpha')!
    expect(alpha.tiers.ro.ok).toBe(false)
    expect(alpha.tiers.ro.error).toMatch(/endpoint/)
    // Error never carries the raw field value.
    expect(alpha.tiers.ro.error).not.toContain('5')
  })

  it('same name in both tiers → merged into one row', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(RO_REGISTRY)
    writeRw(RW_REGISTRY)
    const entries = await handle.listAll()
    const alphas = entries.filter((e) => e.kind === 'test' && e.name === 'alpha')
    expect(alphas).toHaveLength(1)
    expect(alphas[0].tiers.ro).toEqual({ ok: true })
    expect(alphas[0].tiers.rw).toEqual({ ok: true })
  })

  it('response never contains fields', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY)
    writeRw(RW_REGISTRY)
    const entries = await handle.listAll()
    const json = JSON.stringify(entries)
    expect(json).not.toContain('endpoint')
    expect(json).not.toContain('https://')
    expect(json).not.toContain('fields')
  })

  it('envelope is built from entry-level description/environment', async () => {
    const { handle, write, writeRw } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY) // alpha has description "alpha 环境", environment "staging"
    writeRw('test:\n  beta:\n    rw:\n      endpoint: https://rw-beta.internal\n    description: rw-beta\n')
    const entries = await handle.listAll()
    const alpha = entries.find((e) => e.name === 'alpha')!
    expect(alpha.envelope).toEqual({ description: 'alpha 环境', environment: 'staging' })
    const beta = entries.find((e) => e.name === 'beta')!
    expect(beta.envelope).toEqual({ description: 'rw-beta' })
  })

  it('returns empty when the registry file does not exist', async () => {
    const { handle } = setup()
    handle.register(testProvider)
    const entries = await handle.listAll()
    expect(entries).toEqual([])
  })

  it('skips kinds without a registered provider', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(VALID_REGISTRY + 'unregistered:\n  x:\n    whatever: 1\n')
    const entries = await handle.listAll()
    expect(entries.every((e) => e.kind === 'test')).toBe(true)
  })

  it('entries are sorted by kind then name', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write('test:\n  zeta:\n    ro:\n      endpoint: https://z\n  alpha:\n    ro:\n      endpoint: https://a\n')
    const entries = await handle.listAll()
    expect(entries.map((e) => e.name)).toEqual(['alpha', 'zeta'])
  })
})

// ── listKinds ────────────────────────────────────────────────────────────────

describe('listKinds', () => {
  it('returns all registered kinds with their jsonSchema', async () => {
    const { handle } = setup()
    handle.register(testProvider)
    const kinds = handle.listKinds()
    expect(kinds).toHaveLength(1)
    expect(kinds[0].kind).toBe('test')
    expect(kinds[0].jsonSchema).toBeDefined()
    expect(kinds[0].jsonSchema.type).toBe('object')
  })

  it('jsonSchema contains field names and required', () => {
    const { handle } = setup()
    handle.register(testProvider)
    const kinds = handle.listKinds()
    const schema = kinds[0].jsonSchema
    expect(schema.properties).toHaveProperty('endpoint')
    expect(schema.required).toContain('endpoint')
  })

  it('includes fieldsDoc when the provider has one', () => {
    const { handle } = setup()
    handle.register({ ...testProvider, fieldsDoc: 'endpoint: the service URL' })
    const kinds = handle.listKinds()
    expect(kinds[0].fieldsDoc).toBe('endpoint: the service URL')
  })

  it('omits fieldsDoc when the provider has none', () => {
    const { handle } = setup()
    handle.register({ kind: 'bare', schema: zod.object({}) })
    const kinds = handle.listKinds()
    const bare = kinds.find((k) => k.kind === 'bare')!
    expect(bare.fieldsDoc).toBeUndefined()
  })

  it('unregistered kinds do not appear', () => {
    const { handle } = setup()
    handle.register(testProvider)
    const kinds = handle.listKinds()
    expect(kinds.find((k) => k.kind === 'k8s')).toBeUndefined()
  })

  it('kinds are sorted alphabetically', () => {
    const { handle } = setup()
    handle.register({ kind: 'zzz', schema: zod.object({}) })
    handle.register({ kind: 'aaa', schema: zod.object({}) })
    handle.register(testProvider) // 'test'
    const kinds = handle.listKinds()
    expect(kinds.map((k) => k.kind)).toEqual(['aaa', 'test', 'zzz'])
  })
})

// ── admin routes ─────────────────────────────────────────────────────────────

describe('admin routes', () => {
  it('GET /admin/list returns listAll() result without fields', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.adminListRoute()
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    const alpha = body.find((e: any) => e.name === 'alpha')
    expect(alpha.tiers.ro).toEqual({ ok: true })
    expect(alpha.tiers.rw).toEqual({ ok: false })
    expect(alpha.envelope).toEqual({ description: 'alpha 环境', environment: 'staging' })
    // No fields in the response.
    const json = JSON.stringify(body)
    expect(json).not.toContain('endpoint')
    expect(json).not.toContain('https://')
  })

  it('GET /admin/kinds returns listKinds() result with JSON Schema', async () => {
    const h = setup()
    h.handle.register({ ...testProvider, fieldsDoc: 'endpoint: the service URL' })
    const { status, body } = await h.adminKindsRoute()
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].kind).toBe('test')
    expect(body[0].jsonSchema.type).toBe('object')
    expect(body[0].jsonSchema.properties).toHaveProperty('endpoint')
    expect(body[0].jsonSchema.required).toContain('endpoint')
    expect(body[0].fieldsDoc).toBe('endpoint: the service URL')
  })

  it('POST /admin/entry calls writeEntry and returns { ok: true }', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'test', name: 'gamma', tier: 'ro', fields: { endpoint: 'https://gamma.internal' } }),
    })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    // Entry was actually written.
    const profile = await h.handle.resolve('test', 'gamma')
    expect(profile.fields.endpoint).toBe('https://gamma.internal')
  })

  it('POST /admin/entry with envelope fields', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({
        kind: 'test', name: 'gamma', tier: 'ro',
        fields: { endpoint: 'https://gamma.internal' },
        description: 'gamma desc', environment: 'gamma-env',
      }),
    })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    const profile = await h.handle.resolve('test', 'gamma')
    expect(profile.description).toBe('gamma desc')
    expect(profile.environment).toBe('gamma-env')
  })

  it('POST /admin/entry schema failure → { ok: false, error } without field values', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'test', name: 'gamma', tier: 'ro', fields: { wrong: 1 } }),
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/endpoint/)
    expect(body.error).not.toContain('wrong')
  })

  it('POST /admin/entry missing required fields → 400', async () => {
    const h = setup()
    h.handle.register(testProvider)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'test' }),
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  it('POST /admin/entry invalid JSON → 400', async () => {
    const h = setup()
    h.handle.register(testProvider)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: 'not json',
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/JSON/)
  })

  it('DELETE /admin/entry deletes and returns { ok: true }', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.adminEntryRoute({
      method: 'DELETE',
      query: '?kind=test&name=alpha&tier=ro',
    })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    await expect(h.handle.resolve('test', 'alpha')).rejects.toThrow(/no profile "alpha"/)
  })

  it('DELETE /admin/entry non-existent → { ok: false, error }', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.adminEntryRoute({
      method: 'DELETE',
      query: '?kind=test&name=ghost&tier=ro',
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
  })

  it('DELETE /admin/entry missing query params → 400', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.adminEntryRoute({
      method: 'DELETE',
      query: '?kind=test',
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  it('unsupported method on /admin/entry → 405', async () => {
    const h = setup()
    h.handle.register(testProvider)
    // The mock harness doesn't support GET on the entry route, but we can
    // verify the route handles it — simulate with a method the handler
    // doesn't recognize.
    const route = h.routes.find((r) => r.path === '/ops-access/admin/entry')
    let status = 0
    let body: any = null
    await route.handler({ method: 'PUT', url: '/ops-access/admin/entry' },
      { writeHead: (s: number) => { status = s }, end: (text: string) => { body = JSON.parse(text) } })
    expect(status).toBe(405)
    expect(body.ok).toBe(false)
  })
})

// ── existing list route behavior unchanged ──────────────────────────────────

describe('existing routes unchanged', () => {
  it('GET /ops-access/list still serves envelope-only candidates', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(VALID_REGISTRY)
    const { status, body } = await h.listRoute()
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    const json = JSON.stringify(body)
    expect(json).not.toContain('endpoint')
  })
})

// ── register_access tool ─────────────────────────────────────────────────────

/** Fixture provider with a file field and a derivation recipe. */
const fileProvider: AccessProvider = {
  kind: 'files',
  schema: zod.object({ kubeconfig: zod.string(), note: zod.string().optional() }),
  fieldsDoc: 'kubeconfig: path to the kubeconfig file; note: optional inline value',
  fileFields: ['kubeconfig'],
  derivationDoc: 'create account <id>-ro, then register_access',
  // Save-time paste guard: 'corrupt' content stands in for format damage.
  validateContent: (field, content) =>
    field === 'kubeconfig' && content.includes('corrupt') ? 'not a valid kubeconfig' : null,
}

describe('register_access tool', () => {
  it('registers the tool under the expected name', () => {
    const { tools } = setup()
    expect(tools.map((t) => t.name)).toContain('register_access')
  })

  it('writes file-field content to a managed 0600 file and registers the ro tier', async () => {
    const { handle, callRegisterAccess, credentialsDir } = setup()
    handle.register(fileProvider)
    const res = await callRegisterAccess({
      profile: 'files/prod',
      fields: { kubeconfig: 'apiVersion: v1', note: 'inline' },
      description: 'derived ro',
      environment: 'prod',
    })
    expect(res.ok).toBe(true)
    const file = join(credentialsDir, 'files', 'prod', 'ro', 'kubeconfig')
    expect(readFileSync(file, 'utf8')).toBe('apiVersion: v1')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const profile = await handle.resolve('files', 'prod')
    expect(profile.fields).toEqual({ kubeconfig: file, note: 'inline' })
    expect(profile.description).toBe('derived ro')
    expect(profile.environment).toBe('prod')
  })

  it('creates the entry when missing, preserves rw tier and envelope when present', async () => {
    const { handle, callRegisterAccess } = setup()
    handle.register(fileProvider)
    await handle.writeEntry('files', 'prod', 'rw', { kubeconfig: '/rw/path' }, { description: 'keep me' })
    const res = await callRegisterAccess({ profile: 'files/prod', fields: { kubeconfig: 'ro content' } })
    expect(res.ok).toBe(true)
    const rw = await handle.getEntry('files', 'prod', 'rw')
    expect(rw?.description).toBe('keep me')
    // File fields are write-only after save: getEntry reports set status
    // only — never content, not even the stored path.
    expect(rw?.fileFields).toEqual({ kubeconfig: true })
    expect(rw?.fields.kubeconfig).toBeUndefined()
    const ro = await handle.getEntry('files', 'prod', 'ro')
    expect(ro?.fileFields).toEqual({ kubeconfig: true })
    expect(ro?.fields.kubeconfig).toBeUndefined()
  })

  it('clears envelope fields with empty strings', async () => {
    const { handle, callRegisterAccess } = setup()
    handle.register(fileProvider)
    await callRegisterAccess({ profile: 'files/prod', fields: { kubeconfig: 'c' }, description: 'd', environment: 'e' })
    const res = await callRegisterAccess({ profile: 'files/prod', fields: { kubeconfig: 'c' }, description: '', environment: '' })
    expect(res.ok).toBe(true)
    const entry = await handle.getEntry('files', 'prod', 'ro')
    expect(entry?.description).toBeUndefined()
    expect(entry?.environment).toBeUndefined()
  })

  it('rejects a malformed profile string', async () => {
    const { callRegisterAccess } = setup()
    const res = await callRegisterAccess({ profile: 'nokind', fields: {} })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/kind\/id/)
  })

  it('rejects an unknown kind', async () => {
    const { callRegisterAccess } = setup()
    const res = await callRegisterAccess({ profile: 'nope/prod', fields: {} })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/unknown kind "nope"/)
  })

  it('fails schema validation without writing the registry', async () => {
    const { handle, callRegisterAccess, registryFile } = setup()
    handle.register(fileProvider)
    // kubeconfig is required by the schema — omitting it fails validation.
    const res = await callRegisterAccess({ profile: 'files/prod', fields: { note: 'x' } })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/registration failed/)
    expect(existsSync(registryFile)).toBe(false)
  })

  it('schema failure after content write rolls the credential file back', async () => {
    const { handle, callRegisterAccess, registryFile, credentialsDir } = setup()
    handle.register(fileProvider)
    // note must be a string — 42 fails schema AFTER the kubeconfig content
    // file is written. The write must be rolled back: no registry, no file.
    const res = await callRegisterAccess({ profile: 'files/prod', fields: { kubeconfig: 'yaml content', note: 42 } })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/registration failed/)
    expect(existsSync(registryFile)).toBe(false)
    expect(existsSync(join(credentialsDir, 'files', 'prod', 'ro', 'kubeconfig'))).toBe(false)
  })

  it('rejects provider-invalid content BEFORE writing any file', async () => {
    const { handle, callRegisterAccess, registryFile, credentialsDir } = setup()
    handle.register(fileProvider)
    const res = await callRegisterAccess({ profile: 'files/prod', fields: { kubeconfig: 'corrupt paste' } })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/invalid content for files\/prod ro kubeconfig: not a valid kubeconfig/)
    expect(existsSync(registryFile)).toBe(false)
    expect(existsSync(join(credentialsDir, 'files'))).toBe(false)
  })

  it('normalizes the trailing newline when the provider opts in, validating the normalized bytes', async () => {
    const { handle, callRegisterAccess, credentialsDir } = setup()
    const seen: string[] = []
    handle.register({
      ...fileProvider,
      normalizeTrailingNewline: true,
      validateContent: (_field, content) => { seen.push(content); return null },
    })
    const res = await callRegisterAccess({ profile: 'files/prod', fields: { kubeconfig: 'apiVersion: v1\n\n' } })
    expect(res.ok).toBe(true)
    const file = join(credentialsDir, 'files', 'prod', 'ro', 'kubeconfig')
    expect(readFileSync(file, 'utf8')).toBe('apiVersion: v1\n')
    // the validator saw exactly the bytes that landed on disk
    expect(seen).toEqual(['apiVersion: v1\n'])
  })

  it('supports an async validateContent (deep-parse hooks like ssh-keygen)', async () => {
    const { handle, callRegisterAccess } = setup()
    handle.register({
      ...fileProvider,
      validateContent: async (_field, content) => content.includes('async-corrupt') ? 'deep parse failed' : null,
    })
    const bad = await callRegisterAccess({ profile: 'files/prod', fields: { kubeconfig: 'async-corrupt' } })
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/invalid content for files\/prod ro kubeconfig: deep parse failed/)
    const good = await callRegisterAccess({ profile: 'files/prod2', fields: { kubeconfig: 'fine' } })
    expect(good.ok).toBe(true)
  })

  it('rejects a path-hostile id BEFORE writing any credential file', async () => {
    const { handle, callRegisterAccess, credentialsDir } = setup()
    handle.register(fileProvider)
    const res = await callRegisterAccess({ profile: 'files/evil/name', fields: { kubeconfig: 'yaml content' } })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/invalid profile name/)
    expect(existsSync(join(credentialsDir, 'files'))).toBe(false)
  })

  it('help() surfaces derivation recipes and the register_access pointer', () => {
    const { handle } = setup()
    handle.register(fileProvider)
    const text = handle.help()
    expect(text).toContain('derive ro: create account <id>-ro, then register_access')
    expect(text).toContain('register_access tool')
  })
})

// ── admin content-file discipline ────────────────────────────────────────────

describe('admin content files', () => {
  it('POST writes contentFiles to managed 0600 files; getEntry reports set status, never content', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    const { status } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: { note: 'n' }, contentFiles: { kubeconfig: 'yaml content' } }),
    })
    expect(status).toBe(200)
    const file = join(h.credentialsDir, 'files', 'prod', 'ro', 'kubeconfig')
    expect(readFileSync(file, 'utf8')).toBe('yaml content')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const entry = await h.handle.getEntry('files', 'prod', 'ro')
    // Write-only after save: set status only, content nowhere in the result.
    expect(entry?.fileFields).toEqual({ kubeconfig: true })
    expect(entry?.fields.kubeconfig).toBeUndefined()
    expect(JSON.stringify(entry)).not.toContain('yaml content')
    expect(entry?.fields.note).toBe('n')
  })

  it('POST edit without contentFiles carries over the stored credential (write-only preserve)', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: { note: 'n' }, contentFiles: { kubeconfig: 'yaml content' } }),
    })
    // Edit: change note + description only, send no contentFiles — the
    // credential file and its registry path must survive the tier-replace.
    const { status } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: { note: 'n2' }, description: 'edited' }),
    })
    expect(status).toBe(200)
    const file = join(h.credentialsDir, 'files', 'prod', 'ro', 'kubeconfig')
    expect(readFileSync(file, 'utf8')).toBe('yaml content')
    const profile = await h.handle.resolve('files', 'prod')
    expect(profile.fields.kubeconfig).toBe(file)
    expect(profile.fields.note).toBe('n2')
    expect(profile.description).toBe('edited')
  })

  it('empty-string content means untouched — never clobbers the stored file', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: {}, contentFiles: { kubeconfig: 'yaml content' } }),
    })
    const { status } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: {}, contentFiles: { kubeconfig: '' } }),
    })
    expect(status).toBe(200)
    const file = join(h.credentialsDir, 'files', 'prod', 'ro', 'kubeconfig')
    expect(readFileSync(file, 'utf8')).toBe('yaml content')
    await expect(h.handle.resolve('files', 'prod')).resolves.toBeDefined()
  })

  it('POST rejects contentFiles for undeclared fields', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: { kubeconfig: '/p' }, contentFiles: { note: 'x' } }),
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/not a declared file field/)
  })

  it('POST rejects path-escaping file field names', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: {}, contentFiles: { '../escape': 'x' } }),
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/invalid file field name/)
  })

  it('POST rejects provider-invalid content before any file IO', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: {}, contentFiles: { kubeconfig: 'corrupt paste' } }),
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/invalid content for files\/prod ro kubeconfig/)
    expect(existsSync(join(h.credentialsDir, 'files', 'prod'))).toBe(false)
  })

  it('POST with an invalid id writes NO credential files (validation before file IO)', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: '_bad', tier: 'ro', fields: {}, contentFiles: { kubeconfig: 'yaml content' } }),
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/invalid profile name/)
    expect(existsSync(join(h.credentialsDir, 'files', '_bad'))).toBe(false)
  })

  it('POST schema failure after content write rolls the credential file back', async () => {
    const h = setup()
    h.handle.register(fileProvider)
    // note must be a string — 42 fails schema AFTER the content file lands.
    const { status, body } = await h.adminEntryRoute({
      method: 'POST',
      body: JSON.stringify({ kind: 'files', name: 'prod', tier: 'ro', fields: { note: 42 }, contentFiles: { kubeconfig: 'yaml content' } }),
    })
    expect(status).toBe(400)
    expect(existsSync(join(h.credentialsDir, 'files', 'prod', 'ro', 'kubeconfig'))).toBe(false)
    expect(existsSync(join(h.credentialsDir, 'files', 'prod'))).toBe(false)
  })
})

// ── rw-only visibility (the derivation bootstrap) ────────────────────────────

describe('rw-only visibility', () => {
  const RW_ONLY_REGISTRY = `version: 1
test:
  alpha:
    description: alpha 环境
    ro:
      endpoint: https://alpha.internal
  rwonly:
    environment: prod
    rw:
      endpoint: https://rw-only.internal
`

  it('GET /ops-access/list includes rw-only entries with tier readiness flags', async () => {
    const h = setup()
    h.handle.register(testProvider)
    h.write(RW_ONLY_REGISTRY)
    const { status, body } = await h.listRoute()
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    const rwOnly = body.find((c: any) => c.name === 'rwonly')
    expect(rwOnly).toBeDefined()
    expect(rwOnly.ro).toBe(false)
    expect(rwOnly.rw).toBe(true)
    expect(rwOnly.environment).toBe('prod')
    expect(rwOnly.mention).toBe(formatAccessMention({ kind: 'test', name: 'rwonly' }))
    const alpha = body.find((c: any) => c.name === 'alpha')
    expect(alpha.ro).toBe(true)
    // fields never cross
    expect(JSON.stringify(body)).not.toContain('endpoint')
    expect(JSON.stringify(body)).not.toContain('rw-only.internal')
  })

  it('resolve on an rw-only entry points at the register_access derivation path', async () => {
    const { handle, write } = setup()
    handle.register(testProvider)
    write(RW_ONLY_REGISTRY)
    await expect(handle.resolve('test', 'rwonly')).rejects.toThrow(/register_access/)
    // An entry with neither tier keeps the plain error.
    write('version: 1\ntest:\n  bare:\n    description: no tiers\n')
    await expect(handle.resolve('test', 'bare')).rejects.toThrow(/no ro tier for profile "bare"/)
    await expect(handle.resolve('test', 'bare')).rejects.not.toThrow(/register_access/)
  })
})

