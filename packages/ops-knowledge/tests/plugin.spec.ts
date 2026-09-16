/**
 * Plugin-shape spec for ops-knowledge: export shape, no-hub no-op, HMR
 * unload (tools + methodology + reminder leave their registries), and the
 * once-per-session index reminder over a mocked context.
 *
 * The mock context mirrors the cordis semantics that matter here (same
 * pattern as ops-tool-environment's plugin.spec.ts): ctx.effect collects
 * disposers, registry register() calls return working disposers, so running
 * every collected disposer simulates a fiber dispose.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

const CONFIG = { hubUrl: 'http://127.0.0.1:1', hubToken: 't' } // unreachable on purpose

interface MockCtx {
  ctx: any
  tools: any[]
  methodologies: Array<{ name: string, order: number, text: string }>
  reminders: Map<string, { check: (agent: unknown) => string | null }>
  effectCleanups: Array<() => void>
  logs: string[]
}

function mockCtx(opts: { opsPrompts?: 'immediate' | 'deferred' | 'absent' } = {}): MockCtx {
  const mode = opts.opsPrompts ?? 'immediate'
  const tools: any[] = []
  const methodologies: MockCtx['methodologies'] = []
  const reminders: MockCtx['reminders'] = new Map()
  const effectCleanups: Array<() => void> = []
  const logs: string[] = []

  const opsPrompts = {
    registerMethodology: (m: { name: string, order: number, text: string }) => {
      methodologies.push(m)
      return () => {
        const i = methodologies.indexOf(m)
        if (i >= 0) methodologies.splice(i, 1)
      }
    },
    registerReminder: (r: { name: string, check: (agent: unknown) => string | null }) => {
      reminders.set(r.name, r)
      return () => { reminders.delete(r.name) }
    },
  }

  const effect = (fn: () => (() => void) | void): void => {
    const disposer = fn()
    if (disposer) effectCleanups.push(disposer)
  }

  const ctx: any = {
    effect,
    logger: () => ({ info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) }),
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
        cb({ effect, opsPrompts })
      }
    },
  }

  return { ctx, tools, methodologies, reminders, effectCleanups, logs }
}

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-knowledge')
    expect(plugin.inject).toEqual(['tools'])
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
  })
})

describe('no hub configured', () => {
  it('no-ops with a log line: no tools, no prompts', () => {
    const savedUrl = process.env.ACCESS_HUB_URL
    const savedToken = process.env.ACCESS_HUB_READ_TOKEN
    delete process.env.ACCESS_HUB_URL
    delete process.env.ACCESS_HUB_READ_TOKEN
    try {
      const h = mockCtx()
      plugin.apply(h.ctx, {})
      expect(h.tools).toHaveLength(0)
      expect(h.methodologies).toHaveLength(0)
      expect(h.reminders.size).toBe(0)
      expect(h.logs.some((m) => m.includes('knowledge base disabled'))).toBe(true)
    } finally {
      if (savedUrl !== undefined) process.env.ACCESS_HUB_URL = savedUrl
      if (savedToken !== undefined) process.env.ACCESS_HUB_READ_TOKEN = savedToken
    }
  })
})

describe('HMR unload', () => {
  it('disposing all effects removes tools, methodology and reminder', () => {
    const h = mockCtx()
    plugin.apply(h.ctx, CONFIG)
    expect(h.tools.map((t) => t.name).sort()).toEqual(['knowledge_hit', 'knowledge_record', 'knowledge_search'])
    expect(h.methodologies.map((m) => m.name)).toEqual(['knowledge:usage'])
    expect([...h.reminders.keys()]).toEqual(['knowledge:index'])

    for (const cleanup of h.effectCleanups) cleanup()
    expect(h.tools).toHaveLength(0)
    expect(h.methodologies).toHaveLength(0)
    expect(h.reminders.size).toBe(0)
  })

  it('opsPrompts arriving later via inject still wires and unwires', () => {
    const h = mockCtx({ opsPrompts: 'deferred' })
    plugin.apply(h.ctx, CONFIG)
    expect(h.methodologies.map((m) => m.name)).toEqual(['knowledge:usage'])
    for (const cleanup of h.effectCleanups) cleanup()
    expect(h.methodologies).toHaveLength(0)
  })
})

describe('index reminder', () => {
  it('stays silent while the cache is empty (hub unreachable)', () => {
    const h = mockCtx()
    plugin.apply(h.ctx, CONFIG)
    const check = h.reminders.get('knowledge:index')!.check
    expect(check({ session: { id: 's1' } })).toBeNull()
  })
})
