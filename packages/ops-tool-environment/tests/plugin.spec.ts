/**
 * Plugin-shape spec for ops-tool-environment: export shape of both entries
 * (main tool entry + ./prompt subpath) and HMR unload behavior.
 *
 * The mock context mirrors cordis semantics that matter here:
 *   - ctx.effect collects the disposer its callback returns
 *   - tools.register / opsPrompts.registerMethodology return disposers
 *     that actually remove the registration
 * so running every collected disposer simulates a fiber dispose (HMR
 * reload / preset unmount) and every registration surface must be gone.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import * as promptPlugin from '../src/prompt.js'
import type { EnvironmentToolConfig } from '../src/tool.js'

const CONFIG: EnvironmentToolConfig = {
  inventoryFile: '/tmp/test-environment.yaml',
  rulesFile: '/tmp/test-environment-rules.yaml',
  ttlMinutes: 60,
  scanTimeoutMs: 30000,
  prometheusTimeoutMs: 15000,
}

interface MockCtx {
  ctx: any
  tools: any[]
  methodologies: Array<{ name: string, order: number, text: string }>
  effectCleanups: Array<() => void>
}

/**
 * `opsPrompts` mode: 'immediate' resolves via ctx.get (service already
 * provided), 'deferred' only via ctx.inject (provide loses the mount race),
 * 'absent' never resolves.
 */
function mockCtx(opts: { opsPrompts?: 'immediate' | 'deferred' | 'absent' } = {}): MockCtx {
  const mode = opts.opsPrompts ?? 'absent'
  const tools: any[] = []
  const methodologies: MockCtx['methodologies'] = []
  const effectCleanups: Array<() => void> = []

  const opsPrompts = {
    registerMethodology: (m: { name: string, order: number, text: string }) => {
      methodologies.push(m)
      return () => {
        const i = methodologies.indexOf(m)
        if (i >= 0) methodologies.splice(i, 1)
      }
    },
  }

  const effect = (fn: () => (() => void) | void): void => {
    const disposer = fn()
    if (disposer) effectCleanups.push(disposer)
  }

  const ctx: any = {
    effect,
    tools: {
      register: (t: any) => {
        tools.push(t)
        return () => {
          const i = tools.indexOf(t)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
    get: (name: string) => (name === 'opsPrompts' && mode === 'immediate' ? opsPrompts : undefined),
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.includes('opsPrompts') && mode !== 'absent') {
        // cordis's inject-scoped context carries effect — mirror it.
        cb({ effect, opsPrompts })
      }
    },
  }

  return { ctx, tools, methodologies, effectCleanups }
}

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('main entry is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-tool-environment')
    expect(plugin.inject).toEqual(['tools'])
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
  })

  it('prompt entry is a function plugin: named exports, no default', () => {
    expect('default' in promptPlugin).toBe(false)
    expect(promptPlugin.name).toBe('ops-tool-environment-prompt')
    expect(typeof promptPlugin.apply).toBe('function')
  })
})

// ── HMR unload ───────────────────────────────────────────────────────────────

describe('HMR unload', () => {
  it('main entry: disposing all effects removes the environment tool', () => {
    const { ctx, tools, effectCleanups } = mockCtx()
    plugin.apply(ctx, CONFIG)
    expect(tools.map((t) => t.name)).toEqual(['environment'])
    expect(effectCleanups.length).toBeGreaterThan(0)

    for (const cleanup of effectCleanups) cleanup()
    expect(tools).toHaveLength(0)
  })

  it('prompt entry (opsPrompts already present): dispose removes the methodology section', () => {
    const { ctx, methodologies, effectCleanups } = mockCtx({ opsPrompts: 'immediate' })
    promptPlugin.apply(ctx)
    expect(methodologies.map((m) => m.name)).toEqual(['environment:usage'])

    for (const cleanup of effectCleanups) cleanup()
    expect(methodologies).toHaveLength(0)
  })

  it('prompt entry (opsPrompts arrives later via inject): dispose removes the methodology section', () => {
    const { ctx, methodologies, effectCleanups } = mockCtx({ opsPrompts: 'deferred' })
    promptPlugin.apply(ctx)
    expect(methodologies.map((m) => m.name)).toEqual(['environment:usage'])

    for (const cleanup of effectCleanups) cleanup()
    expect(methodologies).toHaveLength(0)
  })

  it('prompt entry without ops-prompts registers nothing and does not throw', () => {
    const { ctx, methodologies, effectCleanups } = mockCtx({ opsPrompts: 'absent' })
    expect(() => promptPlugin.apply(ctx)).not.toThrow()
    expect(methodologies).toHaveLength(0)
    for (const cleanup of effectCleanups) cleanup()
    expect(methodologies).toHaveLength(0)
  })
})
