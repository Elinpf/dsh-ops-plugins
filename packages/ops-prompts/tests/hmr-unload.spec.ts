/**
 * HMR unload spec: simulate fiber disposal by running every collected
 * disposer, then assert every registration surface is gone — the
 * system-prompt methodology section, the agent/pre-step reminder listener,
 * and the bundled skills provider.
 *
 * The mocks' register functions return REAL disposers (splice out of the
 * array/Map), so a registration that never reaches ctx.effect — or whose
 * disposer is dropped — shows up here as a leftover surface.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

function setup(opts: { reminderEnabled?: boolean } = {}) {
  const provided = new Map<string, unknown>()
  const sections: any[] = []
  const listeners: Array<{ event: string, fn: Function }> = []
  const providers: Array<() => any> = []
  /** Disposers cordis runs at fiber teardown: ctx.effect cleanups. */
  const effectCleanups: Array<() => void> = []
  /** ctx.on listeners are fiber-scoped in cordis — the runtime disposes them
   *  automatically at teardown; the mock mirrors that scope explicitly. */
  const listenerDisposers: Array<() => void> = []

  const registry = {
    registerProvider: (factory: () => any) => {
      providers.push(factory)
      return () => { providers.splice(providers.indexOf(factory), 1) }
    },
  }

  const ctx: any = {
    provide: (key: string, value: unknown) => { provided.set(key, value) },
    // Declared required inject — present by definition when apply runs.
    systemPrompt: {
      section: (s: any) => {
        sections.push(s)
        return () => { sections.splice(sections.indexOf(s), 1) }
      },
    },
    get: (key: string) => key === 'skills' ? registry : undefined,
    inject: () => {},
    effect: (fn: () => (() => void) | void) => { const d = fn(); if (d) effectCleanups.push(d) },
    on: (event: string, fn: Function) => {
      const entry = { event, fn }
      listeners.push(entry)
      const d = () => { listeners.splice(listeners.indexOf(entry), 1) }
      listenerDisposers.push(d)
      return d
    },
    logger: () => ({ warn: () => {} }),
  }
  plugin.apply(ctx, { reminderEnabled: opts.reminderEnabled ?? true })

  return {
    handle: provided.get('opsPrompts') as plugin.OpsPromptsHandle,
    sections, listeners, providers, effectCleanups, listenerDisposers,
  }
}

describe('HMR unload', () => {
  it('registers every surface fiber-scoped: section and provider via ctx.effect, listener via ctx.on', () => {
    const h = setup()
    expect(h.handle).toBeDefined()
    expect(h.sections).toHaveLength(1)
    expect(h.listeners).toHaveLength(1)
    expect(h.providers).toHaveLength(1)
    // Section + skills provider both go through ctx.effect.
    expect(h.effectCleanups).toHaveLength(2)
    expect(h.listenerDisposers).toHaveLength(1)
  })

  it('running all disposers removes every registration surface', () => {
    const h = setup()
    for (const cleanup of h.effectCleanups) cleanup()
    for (const dispose of h.listenerDisposers) dispose()
    expect(h.sections).toHaveLength(0)
    expect(h.listeners).toHaveLength(0)
    expect(h.providers).toHaveLength(0)
  })

  it('reminder-disabled configs leave no listener behind after teardown', () => {
    const h = setup({ reminderEnabled: false })
    expect(h.listeners).toHaveLength(0)
    for (const cleanup of h.effectCleanups) cleanup()
    expect(h.sections).toHaveLength(0)
    expect(h.providers).toHaveLength(0)
  })
})
