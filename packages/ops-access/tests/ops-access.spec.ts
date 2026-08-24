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
