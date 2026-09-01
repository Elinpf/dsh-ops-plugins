/**
 * ops-panel tests: the node-side registerPanelCommand helper (fake ctx) and
 * the React-free PanelCore registry/dispatch machine. ShellView rendering
 * against the real overlay-frame props lives in shell-view.spec.ts (jsdom).
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as nodePlugin from '../src/index.ts'
import * as clientPlugin from '../src/client.ts'
import { registerPanelCommand } from '../src/index.ts'
import { createPanelCore, apply as applyClient } from '../src/client.ts'
import type { OpsPanels, PanelDefinition } from '../src/types.ts'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape (node half)', () => {
  it('is a function plugin: name/inject/Config/apply, no default export', () => {
    expect(nodePlugin.name).toBe('ops-panel')
    expect(nodePlugin.inject).toEqual([])
    expect(nodePlugin.Config).toBeDefined()
    expect(typeof nodePlugin.apply).toBe('function')
    expect('default' in nodePlugin).toBe(false)
    // Empty by design — the row exists for client-bundle discovery only.
    expect(() => nodePlugin.apply({} as never)).not.toThrow()
  })
})

describe('export shape (client half)', () => {
  it('is a function plugin: name/inject/apply, no default export', () => {
    expect(clientPlugin.name).toBe('ops-panel-client')
    expect(clientPlugin.inject).toEqual(['slots'])
    expect(typeof clientPlugin.apply).toBe('function')
    expect('default' in clientPlugin).toBe(false)
  })
})

// ── registerPanelCommand ─────────────────────────────────────────────────────

interface RegisteredDefinition {
  name: string
  description: string
  handler: () => { kind: string; text?: string }
}

function fakeCtx(commands?: { register(def: RegisteredDefinition): () => void }) {
  const disposers: Array<() => void> = []
  const ctx = {
    get: (key: string) => (key === 'commands' ? commands : undefined),
    effect: (fn: () => () => void) => { const d = fn(); disposers.push(d); return d },
  } as unknown as Context
  return { ctx, disposers }
}

function fakeRegistry() {
  const registered = new Map<string, RegisteredDefinition>()
  return {
    registered,
    register(def: RegisteredDefinition) {
      registered.set(def.name, def)
      return () => { registered.delete(def.name) }
    },
  }
}

describe('registerPanelCommand', () => {
  it('rejects invalid command names', () => {
    const { ctx } = fakeCtx(fakeRegistry())
    expect(() => registerPanelCommand(ctx, { name: 'Access', description: 'x' })).toThrow(/invalid panel command name/)
    expect(() => registerPanelCommand(ctx, { name: 'has space', description: 'x' })).toThrow(/invalid panel command name/)
    expect(() => registerPanelCommand(ctx, { name: '/prefixed', description: 'x' })).toThrow(/invalid panel command name/)
  })

  it('fails loud when the commands service is not composed', () => {
    const { ctx } = fakeCtx(undefined)
    expect(() => registerPanelCommand(ctx, { name: 'access', description: 'x' })).toThrow(/commands service is not composed/)
  })

  it('registers a no-op success command through an effect', () => {
    const registry = fakeRegistry()
    const { ctx } = fakeCtx(registry)
    registerPanelCommand(ctx, { name: 'access', description: 'Open the access panel' })
    const def = registry.registered.get('access')
    expect(def).toBeDefined()
    expect(def!.description).toBe('Open the access panel')
    expect(def!.handler()).toEqual({ kind: 'success', text: 'Opening panel: access' })
  })

  it('unregisters when the calling fiber is disposed', () => {
    const registry = fakeRegistry()
    const { ctx, disposers } = fakeCtx(registry)
    registerPanelCommand(ctx, { name: 'access', description: 'x' })
    expect(registry.registered.has('access')).toBe(true)
    for (const dispose of disposers) dispose()
    expect(registry.registered.has('access')).toBe(false)
  })
})

// ── PanelCore ────────────────────────────────────────────────────────────────

function panel(command: string, extra?: Partial<PanelDefinition>): PanelDefinition {
  return { command, title: 'T:' + command, component: () => null, ...extra }
}

describe('PanelCore', () => {
  it('registers and resolves panels by command name', () => {
    const core = createPanelCore()
    core.registerPanel(panel('access'))
    expect(core.get('access')?.title).toBe('T:access')
    expect(core.get('other')).toBeUndefined()
  })

  it('rejects duplicate command names', () => {
    const core = createPanelCore()
    core.registerPanel(panel('access'))
    expect(() => core.registerPanel(panel('access'))).toThrow(/already registered/)
  })

  it('disposer removes the panel', () => {
    const core = createPanelCore()
    const dispose = core.registerPanel(panel('access'))
    dispose()
    expect(core.get('access')).toBeUndefined()
    expect(core.open('s1', 'access')).toBe(false)
  })

  it('opens a registered panel and publishes an immutable snapshot', () => {
    const core = createPanelCore()
    core.registerPanel(panel('access'))
    const before = core.getSnapshot()
    let notified = 0
    core.subscribe(() => { notified += 1 })
    expect(core.open('s1', 'access')).toBe(true)
    expect(core.getSnapshot()).not.toBe(before)
    expect(core.getSnapshot().get('s1')).toBe('access')
    expect(notified).toBe(1)
  })

  it('refuses unknown commands and unavailable sessions', () => {
    const core = createPanelCore()
    core.registerPanel(panel('access', { available: (sid) => sid === 'ops-session' }))
    expect(core.open('s1', 'nope')).toBe(false)
    expect(core.open('random', 'access')).toBe(false)
    expect(core.getSnapshot().size).toBe(0)
    expect(core.open('ops-session', 'access')).toBe(true)
  })

  it('close removes only that session and is idempotent', () => {
    const core = createPanelCore()
    core.registerPanel(panel('access'))
    core.open('s1', 'access')
    core.open('s2', 'access')
    core.close('s1')
    expect(core.getSnapshot().has('s1')).toBe(false)
    expect(core.getSnapshot().get('s2')).toBe('access')
    let notified = 0
    core.subscribe(() => { notified += 1 })
    core.close('s1')
    expect(notified).toBe(0)
  })

  it('handleCommandExecuted ignores unregistered commands', () => {
    const core = createPanelCore()
    core.registerPanel(panel('access'))
    core.handleCommandExecuted('s1', 'compact')
    expect(core.getSnapshot().size).toBe(0)
    core.handleCommandExecuted('s1', 'access')
    expect(core.getSnapshot().get('s1')).toBe('access')
  })
})

// ── OpsPanels service face (apply wiring) ───────────────────────────────────

describe('opsPanels service face', () => {
  /** Boot client apply with the minimum fake ctx; capture the provided service. */
  function bootClient(): OpsPanels {
    let provided: OpsPanels | undefined
    const ctx = {
      provide: (key: string, value: unknown) => { if (key === 'opsPanels') provided = value as OpsPanels },
      on: () => {},
      get: () => undefined,
      effect: (fn: () => () => void) => fn(),
    } as unknown as Context
    applyClient(ctx)
    if (provided === undefined) throw new Error('opsPanels was not provided')
    return provided
  }

  it('exposes imperative open/close beside registerPanel', () => {
    const svc = bootClient()
    svc.registerPanel({ command: 'access', title: 't', component: () => null })
    expect(svc.open('s1', 'access')).toBe(true)
    expect(svc.open('s1', 'unregistered')).toBe(false)
    svc.close('s1') // no throw with no panel open
  })

  it('open honours the availability filter', () => {
    const svc = bootClient()
    svc.registerPanel({ command: 'access', title: 't', component: () => null, available: (sid) => sid === 'ops' })
    expect(svc.open('other', 'access')).toBe(false)
    expect(svc.open('ops', 'access')).toBe(true)
  })
})

// ── HMR unload (client half) ────────────────────────────────────────────────

describe('HMR unload (client half)', () => {
  /**
   * Boot client apply with a fiber-faithful mock: every registration surface
   * (provided service, event listener, slot entry) is tied to the fiber the
   * way cordis ties them, and effect disposers are collected for replay.
   */
  function bootHmr() {
    const effectCleanups: Array<() => void> = []
    const provided = new Map<string, unknown>()
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const slotEntries: Array<Record<string, unknown>> = []
    const slots = {
      inject(_slot: string, factory: () => unknown) {
        const inner = factory() as (() => void) | undefined
        return () => { inner?.() }
      },
      register(opts: Record<string, unknown>, component: unknown) {
        const entry = { ...opts, component }
        slotEntries.push(entry)
        return () => { slotEntries.splice(slotEntries.indexOf(entry), 1) }
      },
    }
    const ctx = {
      provide(key: string, value: unknown) {
        provided.set(key, value)
        effectCleanups.push(() => { provided.delete(key) })
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        let set = listeners.get(event)
        if (!set) listeners.set(event, (set = new Set()))
        set.add(cb)
        effectCleanups.push(() => { set.delete(cb) })
      },
      get: (key: string) => (key === 'slots' ? slots : undefined),
      effect(fn: () => () => void) {
        const dispose = fn()
        effectCleanups.push(dispose)
        return dispose
      },
    } as unknown as Context
    applyClient(ctx)
    return { effectCleanups, provided, listeners, slotEntries }
  }

  it('registers the service, the dispatcher, and the overlay shell on apply', () => {
    const { provided, listeners, slotEntries } = bootHmr()
    expect(provided.has('opsPanels')).toBe(true)
    expect(listeners.get('command/executed')?.size).toBe(1)
    expect(slotEntries).toHaveLength(1)
    expect(slotEntries[0]).toMatchObject({ name: 'conversation.input.overlay', id: 'ops-panel' })
  })

  it('disposing every effect removes every registration surface', () => {
    const { effectCleanups, provided, listeners, slotEntries } = bootHmr()
    expect(effectCleanups.length).toBeGreaterThan(0)
    for (const dispose of effectCleanups) dispose()
    // The overlay shell entry is gone from the slot registry.
    expect(slotEntries).toHaveLength(0)
    // The single command/executed dispatcher is unlistened.
    expect(listeners.get('command/executed')?.size ?? 0).toBe(0)
    // The opsPanels service is unprovided.
    expect(provided.has('opsPanels')).toBe(false)
  })
})
