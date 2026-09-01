/**
 * HMR unload spec: disposing the plugin's fiber must remove every
 * registration surface — the trace tool, the methodology section, and both
 * reminders — from the registries they were added to, plus the in-process
 * tree state. Mirrors what cordis does on HMR reload / preset unmount: run
 * every effect disposer, then assert nothing leaks.
 */

import { describe, it, expect } from 'vitest'
import { setup } from './harness.ts'

describe('HMR unload', () => {
  it('disposing the fiber removes tool, methodology, and both reminders', () => {
    const h = setup()

    // Mounted: one tool, one methodology, two reminders; projection is NOT
    // registered here (ops-trace-ui owns it host-plane).
    expect(h.tools.map((t) => t.name)).toEqual(['trace'])
    expect(h.opsPrompts.methodologies.map((m) => m.name)).toEqual(['trace:usage'])
    expect([...h.opsPrompts.reminders.keys()].sort()).toEqual(['trace:idle', 'trace:nesting'])
    expect(h.registeredProjections).toHaveLength(0)

    h.dispose()

    // Every surface is gone — nothing outlives the fiber.
    expect(h.tools).toHaveLength(0)
    expect(h.opsPrompts.methodologies).toHaveLength(0)
    expect(h.opsPrompts.reminders.size).toBe(0)
    expect(h.registeredProjections).toHaveLength(0)
  })

  it('disposal also drops in-process tree state (store re-seeds from the projection)', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    const before = await h.run({ action: 'view' })
    expect(before.tree.nodes).toHaveLength(1)

    h.dispose()

    // The store was cleared; with a null projection snapshot the tool no
    // longer sees the tree it built before disposal.
    await expect(h.run({ action: 'view' })).rejects.toThrow('no tree')
  })

  it('host-plane mount (no opsPrompts) still unregisters the tool on dispose', () => {
    const h = setup({ withOpsPrompts: false })
    expect(h.tools.map((t) => t.name)).toEqual(['trace'])
    expect(h.opsPrompts.methodologies).toHaveLength(0)
    expect(h.opsPrompts.reminders.size).toBe(0)

    h.dispose()

    expect(h.tools).toHaveLength(0)
    expect(h.opsPrompts.methodologies).toHaveLength(0)
    expect(h.opsPrompts.reminders.size).toBe(0)
  })
})
