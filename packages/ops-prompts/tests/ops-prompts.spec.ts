/**
 * Unit spec for ops-prompts: the opsPrompts handle (methodology + reminder
 * registration), methodology aggregation into the system prompt section, and
 * the agent/pre-step listener's durable reminder delivery via agent.inject.
 */

import { describe, it, expect } from 'vitest'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

function setup(opts: { reminderEnabled?: boolean } = {}) {
  const provided = new Map<string, unknown>()
  const sections: Array<{ name: string, order: number, text: unknown }> = []

  const ctx: any = {
    provide: (key: string, value: unknown) => { provided.set(key, value) },
    // Declared required inject — present by definition when apply runs.
    systemPrompt: { section: (s: any) => { sections.push(s); return () => {} } },
    get: () => undefined,
    on: (event: string, fn: Function) => { listeners.push({ event, fn }); return () => {} },
    effect: (fn: () => (() => void) | void) => { fn() },
    inject: () => {}, // no skills registry in these tests — the fallback must stay inert
  }
  const listeners: Array<{ event: string, fn: Function }> = []
  plugin.apply(ctx, { reminderEnabled: opts.reminderEnabled ?? true })

  return {
    handle: provided.get('opsPrompts') as plugin.OpsPromptsHandle,
    sections,
    listeners,
  }
}

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-prompts')
    expect(plugin.inject).toEqual(['systemPrompt'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeDefined()
  })

  it('invariant companion is a function plugin too', () => {
    expect('default' in invariant).toBe(false)
    expect(invariant.name).toBe('ops-prompts-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(typeof invariant.apply).toBe('function')
  })

  it('re-exports the pure types from ./types (type-level compat)', async () => {
    // Compile-time check: the interfaces must remain importable from the
    // package root after moving to types.ts.
    const entry: import('../src/types.ts').MethodologyEntry = { name: 'x', order: 1, text: 't' }
    const handle: Pick<plugin.OpsPromptsHandle, 'registerMethodology'> = {
      registerMethodology: (opts: plugin.MethodologyEntry) => { void opts; return () => {} },
    }
    expect(handle.registerMethodology(entry)).toBeInstanceOf(Function)
  })
})

// ── Methodology registration and aggregation ────────────────────────────────

describe('methodology', () => {
  it('provides the opsPrompts handle and registers the core methodology', () => {
    const { handle } = setup()
    expect(handle).toBeDefined()
    expect(typeof handle.registerMethodology).toBe('function')
    expect(typeof handle.registerReminder).toBe('function')
  })

  it('aggregates registered methodologies into one section, ordered by order', () => {
    const { handle, sections } = setup()
    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe('ops:methodology')

    const dispose = handle.registerMethodology({ name: 'b', order: 300, text: 'SECOND' })
    handle.registerMethodology({ name: 'a', order: 100, text: 'FIRST' })
    const text = (sections[0].text as () => string)()
    expect(text.indexOf('FIRST')).toBeLessThan(text.indexOf('Ops investigation discipline'))
    expect(text.indexOf('Ops investigation discipline')).toBeLessThan(text.indexOf('SECOND'))

    dispose()
    expect((sections[0].text as () => string)()).not.toContain('SECOND')
  })

  it('registers the methodology section through the declared systemPrompt inject', () => {
    const { sections } = setup()
    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe('ops:methodology')
  })
})

// ── Reminder delivery ────────────────────────────────────────────────────────

describe('reminder delivery', () => {
  const enter = { kind: 'enter', messages: [] as unknown[] }

  it('registers the pre-step listener only when reminderEnabled', () => {
    expect(setup().listeners.map((l) => l.event)).toEqual(['agent/pre-step'])
    expect(setup({ reminderEnabled: false }).listeners).toHaveLength(0)
  })

  it('injects a plugin notice through agent.inject when a rule fires', async () => {
    const { handle, listeners } = setup()
    handle.registerReminder({ name: 'r1', check: () => 'NAG' })

    const injected: any[] = []
    const agent = { inject: (msg: any) => injected.push(msg) }
    const decision = await listeners[0].fn({ agent }, async () => enter)

    expect(decision).toBe(enter) // decision passes through unchanged
    expect(injected).toHaveLength(1)
    expect(injected[0].role).toBe('user')
    expect(injected[0].content[0].text).toBe('NAG')
    expect(injected[0].source).toMatchObject({ kind: 'plugin', plugin: 'ops-prompts', form: 'notice' })
  })

  it('joins multiple fired rules into one notice', async () => {
    const { handle, listeners } = setup()
    handle.registerReminder({ name: 'r1', check: () => 'A' })
    handle.registerReminder({ name: 'r2', check: () => 'B' })

    const injected: any[] = []
    await listeners[0].fn({ agent: { inject: (m: any) => injected.push(m) } }, async () => enter)
    expect(injected).toHaveLength(1)
    expect(injected[0].content[0].text).toBe('A\nB')
  })

  it('injects nothing when no rule fires', async () => {
    const { handle, listeners } = setup()
    handle.registerReminder({ name: 'r1', check: () => null })

    const injected: any[] = []
    const decision = await listeners[0].fn({ agent: { inject: (m: any) => injected.push(m) } }, async () => enter)
    expect(decision).toBe(enter)
    expect(injected).toHaveLength(0)
  })

  it('passes reject decisions through without evaluating rules', async () => {
    const { handle, listeners } = setup()
    let evaluated = false
    handle.registerReminder({ name: 'r1', check: () => { evaluated = true; return 'X' } })

    const reject = { kind: 'reject' }
    const decision = await listeners[0].fn({ agent: {} }, async () => reject)
    expect(decision).toBe(reject)
    expect(evaluated).toBe(false)
  })

  it('tolerates a payload without an injectable agent', async () => {
    const { handle, listeners } = setup()
    handle.registerReminder({ name: 'r1', check: () => 'X' })
    const decision = await listeners[0].fn({}, async () => enter)
    expect(decision).toBe(enter)
  })
})
