/**
 * Reminder rule specs: trace:idle (cadence) and trace:nesting (flat-tree
 * detector). Covers triggers, resolved-tree guard, latches, and fire caps.
 *
 * The check functions replay the full event history on every call, so specs
 * build synthetic event logs and call the captured check directly.
 */

import { describe, it, expect } from 'vitest'
import { setup, agentWithEvents, stepStart, traceCall } from './harness.ts'

type Check = (agent: unknown) => string | null

function reminders(): { idle: Check, nesting: Check } {
  const { opsPrompts } = setup()
  return {
    idle: opsPrompts.reminders.get('trace:idle')!,
    nesting: opsPrompts.reminders.get('trace:nesting')!,
  }
}

// ── trace:idle ───────────────────────────────────────────────────────────────

describe('trace:idle', () => {
  it('stays silent without events or without a tree', () => {
    const { idle } = reminders()
    expect(idle(agentWithEvents([]))).toBeNull()
    expect(idle(agentWithEvents([stepStart(1, 1)]))).toBeNull()
  })

  it('fires after 5 steps without a trace update', () => {
    const { idle } = reminders()
    const agent = agentWithEvents([
      stepStart(1, 1),
      traceCall({ action: 'create_tree', goal_title: 'G' }),
      stepStart(1, 6),
    ])
    expect(idle(agent)).toContain('REMINDER')
  })

  it('stays silent below the 5-step gap', () => {
    const { idle } = reminders()
    const agent = agentWithEvents([
      stepStart(1, 1),
      traceCall({ action: 'create_tree', goal_title: 'G' }),
      stepStart(1, 4),
    ])
    expect(idle(agent)).toBeNull()
  })

  it('latches: refires only after 5 further steps', () => {
    const { idle } = reminders()
    const base = [stepStart(1, 1), traceCall({ action: 'create_tree', goal_title: 'G' })]
    expect(idle(agentWithEvents([...base, stepStart(1, 6)]))).toContain('REMINDER')
    expect(idle(agentWithEvents([...base, stepStart(1, 7)]))).toBeNull()
    expect(idle(agentWithEvents([...base, stepStart(1, 11)]))).toContain('REMINDER')
  })

  it('never fires once the tree is resolved', () => {
    const { idle } = reminders()
    const agent = agentWithEvents([
      stepStart(1, 1),
      traceCall({ action: 'create_tree', goal_title: 'G' }),
      traceCall({ action: 'resolve', id: 'goal', summary: 'done' }),
      stepStart(1, 20),
    ])
    expect(idle(agent)).toBeNull()
  })

  it('fires at most 5 times per session', () => {
    const { idle } = reminders()
    const base = [stepStart(1, 1), traceCall({ action: 'create_tree', goal_title: 'G' })]
    const results: (string | null)[] = []
    for (let s = 6; s <= 60; s += 5) {
      results.push(idle(agentWithEvents([...base, stepStart(1, s)])))
    }
    expect(results.filter((r) => r !== null)).toHaveLength(5)
    expect(results[results.length - 1]).toBeNull()
  })
})

// ── trace:nesting ────────────────────────────────────────────────────────────

describe('trace:nesting', () => {
  function flatTreeEvents(stepCount: number, opts: { finding?: boolean, nested?: boolean } = {}) {
    const evs: any[] = [
      stepStart(1, 1),
      traceCall({ action: 'create_tree', goal_title: 'G' }),
      traceCall({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1' }),
    ]
    for (let i = 1; i <= stepCount; i++) {
      // When nested, s3 hangs under s2 instead of the milestone
      const parent = opts.nested && i === 3 ? 's2' : 'm1'
      evs.push(traceCall({ action: 'add_step', id: `s${i}`, parent_id: parent, title: `S${i}` }))
    }
    if (opts.finding) evs.push(traceCall({ action: 'complete', id: 's1', summary: 'found something' }))
    return evs
  }

  it('stays silent with fewer than 3 steps', () => {
    const { nesting } = reminders()
    expect(nesting(agentWithEvents(flatTreeEvents(2, { finding: true })))).toBeNull()
  })

  it('stays silent when no completed step carries a finding', () => {
    const { nesting } = reminders()
    expect(nesting(agentWithEvents(flatTreeEvents(3)))).toBeNull()
  })

  it('fires when 3+ steps are flat under milestones and a finding exists', () => {
    const { nesting } = reminders()
    expect(nesting(agentWithEvents(flatTreeEvents(3, { finding: true })))).toContain('REMINDER')
  })

  it('stays silent once a step nests under another step', () => {
    const { nesting } = reminders()
    expect(nesting(agentWithEvents(flatTreeEvents(4, { finding: true, nested: true })))).toBeNull()
  })

  it('never fires once the tree is resolved', () => {
    const { nesting } = reminders()
    const evs = flatTreeEvents(3, { finding: true })
    evs.push(traceCall({ action: 'resolve', id: 'goal', summary: 'done' }))
    expect(nesting(agentWithEvents(evs))).toBeNull()
  })

  it('latches on flat-step count growth, not on replay of history', () => {
    const { nesting } = reminders()
    // Fire once with 3 flat steps
    expect(nesting(agentWithEvents(flatTreeEvents(3, { finding: true })))).toContain('REMINDER')
    // Same shape re-evaluated (the old latch-reset bug refired here)
    expect(nesting(agentWithEvents(flatTreeEvents(3, { finding: true })))).toBeNull()
    // A new flat step → refire once
    expect(nesting(agentWithEvents(flatTreeEvents(4, { finding: true })))).toContain('REMINDER')
  })

  it('a new tree re-arms the rule', () => {
    const { nesting } = reminders()
    expect(nesting(agentWithEvents(flatTreeEvents(3, { finding: true })))).toContain('REMINDER')
    // New investigation: shape resets, so no fire until the new tree goes flat again
    const second = [traceCall({ action: 'create_tree', goal_title: 'G2' })]
    expect(nesting(agentWithEvents([...flatTreeEvents(3, { finding: true }), ...second]))).toBeNull()
    const flatAgain = [
      ...flatTreeEvents(3, { finding: true }),
      ...second,
      traceCall({ action: 'add_milestone', id: 'm2', parent_id: 'goal', title: 'M2' }),
      traceCall({ action: 'add_step', id: 'x1', parent_id: 'm2', title: 'X1' }),
      traceCall({ action: 'add_step', id: 'x2', parent_id: 'm2', title: 'X2' }),
      traceCall({ action: 'add_step', id: 'x3', parent_id: 'm2', title: 'X3' }),
      traceCall({ action: 'complete', id: 'x1', summary: 'found' }),
    ]
    expect(nesting(agentWithEvents(flatAgain))).toContain('REMINDER')
  })

  it('fires at most 5 times per session', () => {
    const { nesting } = reminders()
    let fires = 0
    for (let n = 3; n <= 10; n++) {
      if (nesting(agentWithEvents(flatTreeEvents(n, { finding: true }))) !== null) fires++
    }
    expect(fires).toBe(5)
  })
})
