/**
 * Reminder specs: buildReminderContext derivation, the two rules as pure
 * functions of ReminderContext, and the ReminderLatch abstraction.
 *
 * Rules no longer parse raw event history — contexts are hand-built, which is
 * the point of the deepened module: tests construct a small state object
 * instead of a synthetic event log.
 */

import { describe, it, expect } from 'vitest'
import {
  buildReminderContext, createIdleRule, createNestingRule, ReminderLatch,
} from '../src/reminders.ts'
import type { ReminderContext } from '../src/reminders.ts'
import { SessionForestStore } from '../src/session-forests.ts'
import { foldEvent } from '../src/index.ts'
import type { NodeStatus, TreeNode, TreeState } from '../src/types.ts'

// ── Builders ─────────────────────────────────────────────────────────────────

function node(id: string, parent: string | null, status: NodeStatus = 'pending', summary: string | null = null): TreeNode {
  return { id, title: id, status, parent, turns: [1], summary, detail: null, caused_by: [] }
}

function treeWith(nodes: TreeNode[], resolved = false): TreeState {
  return { nodes, resolved }
}

function ctxWith(overrides: Partial<ReminderContext> & { tree: TreeState | null }): ReminderContext {
  return {
    sessionId: 's1',
    currentStep: 10,
    lastTraceStep: 1,
    forest: { trees: overrides.tree ? [overrides.tree] : [] },
    ...overrides,
  }
}

/** goal → m1 → s1,s2,s3 (flat), all steps pending. */
function flatTree(stepCount: number, opts: { finding?: boolean, nested?: boolean, resolved?: boolean } = {}) {
  const nodes: TreeNode[] = [
    node('goal', null, 'goal'),
    node('m1', 'goal', 'goal'),
  ]
  for (let i = 1; i <= stepCount; i++) {
    // When nested, s3 hangs under s2 instead of the milestone
    const parent = opts.nested && i === 3 ? 's2' : 'm1'
    nodes.push(node(`s${i}`, parent))
  }
  if (opts.finding) nodes[2].summary = 'found something'
  return treeWith(nodes, opts.resolved ?? false)
}

// ── ReminderLatch ────────────────────────────────────────────────────────────

describe('ReminderLatch', () => {
  it('fires on first version, then only after minGap advancement', () => {
    const latch = new ReminderLatch(5, 10)
    expect(latch.shouldFire('s', 10)).toBe(true)
    expect(latch.shouldFire('s', 12)).toBe(false)
    expect(latch.shouldFire('s', 15)).toBe(true)
  })

  it('caps fires per session', () => {
    const latch = new ReminderLatch(1, 3)
    expect([1, 2, 3, 4, 5].map((v) => latch.shouldFire('s', v))).toEqual([true, true, true, false, false])
  })

  it('is idempotent against re-evaluating the same state (the history-replay regression)', () => {
    const latch = new ReminderLatch(1, 5)
    expect(latch.shouldFire('s', 3)).toBe(true)
    // Replaying history yields the same version — no refire, no reset.
    expect(latch.shouldFire('s', 3)).toBe(false)
    expect(latch.shouldFire('s', 3)).toBe(false)
  })

  it('tracks sessions independently', () => {
    const latch = new ReminderLatch(5, 2)
    expect(latch.shouldFire('a', 1)).toBe(true)
    expect(latch.shouldFire('b', 1)).toBe(true)
  })

  it('accepts a gap function of the fire count and doubles the required gap', () => {
    const latch = new ReminderLatch((fires) => 5 * 2 ** (fires - 1), 50)
    expect(latch.shouldFire('s', 10)).toBe(true)
    // after 1 fire: gap 5
    expect(latch.shouldFire('s', 14)).toBe(false)
    expect(latch.shouldFire('s', 15)).toBe(true)
    // after 2 fires: gap 10
    expect(latch.shouldFire('s', 24)).toBe(false)
    expect(latch.shouldFire('s', 25)).toBe(true)
    // after 3 fires: gap 20, then 40
    expect(latch.shouldFire('s', 44)).toBe(false)
    expect(latch.shouldFire('s', 45)).toBe(true)
    expect(latch.shouldFire('s', 84)).toBe(false)
    expect(latch.shouldFire('s', 85)).toBe(true)
  })

  it('still caps at maxFires with a gap function', () => {
    const latch = new ReminderLatch((fires) => 5 * 2 ** (fires - 1), 3)
    expect(latch.shouldFire('s', 0)).toBe(true)
    expect(latch.shouldFire('s', 5)).toBe(true)
    expect(latch.shouldFire('s', 15)).toBe(true)
    expect(latch.shouldFire('s', 1000)).toBe(false)
  })

  it('supports a gap ceiling through the function form', () => {
    const latch = new ReminderLatch((fires) => Math.min(5 * 2 ** (fires - 1), 40), 1000)
    expect(latch.shouldFire('s', 10)).toBe(true)
    expect(latch.shouldFire('s', 15)).toBe(true) // +5
    expect(latch.shouldFire('s', 25)).toBe(true) // +10
    expect(latch.shouldFire('s', 45)).toBe(true) // +20
    expect(latch.shouldFire('s', 85)).toBe(true) // +40, not +80
    expect(latch.shouldFire('s', 124)).toBe(false)
    expect(latch.shouldFire('s', 125)).toBe(true) // +40 floor forever
  })

  it('forgets fire history on reset (firedAt / reset)', () => {
    const latch = new ReminderLatch((fires) => 5 * 2 ** (fires - 1), 50)
    expect(latch.shouldFire('s', 10)).toBe(true)
    expect(latch.shouldFire('s', 15)).toBe(true)
    expect(latch.firedAt('s')).toBe(15)
    latch.reset('s')
    expect(latch.firedAt('s')).toBeUndefined()
    // fresh first fire: immediate, no gap owed
    expect(latch.shouldFire('s', 16)).toBe(true)
  })
})

// ── trace:idle rule ──────────────────────────────────────────────────────────

describe('idle rule', () => {
  const rule = () => createIdleRule(new ReminderLatch(5, 5))

  it('silent without a tree or without any trace call', () => {
    expect(rule()(ctxWith({ tree: null }))).toBeNull()
    expect(rule()(ctxWith({ tree: flatTree(1), lastTraceStep: 0 }))).toBeNull()
  })

  it('fires at a 5+ step gap, silent below it', () => {
    const r = rule()
    expect(r(ctxWith({ tree: flatTree(1), currentStep: 100, lastTraceStep: 95 }))).toContain('REMINDER')
    expect(rule()(ctxWith({ tree: flatTree(1), currentStep: 100, lastTraceStep: 97 }))).toBeNull()
  })

  it('silent once the tree is resolved', () => {
    expect(rule()(ctxWith({ tree: flatTree(1, { resolved: true }), currentStep: 100, lastTraceStep: 1 }))).toBeNull()
  })

  it('latch refires every 5 steps, capped at 5 per session', () => {
    const r = rule()
    const results = []
    for (let s = 10; s <= 60; s += 5) {
      results.push(r(ctxWith({ tree: flatTree(1), currentStep: s, lastTraceStep: 1 })))
    }
    expect(results.filter((x) => x !== null)).toHaveLength(5)
  })
})

// Production wiring (index.ts): the gap doubles after each fire with a
// 40-step ceiling, and the rule resets the backoff when the agent answers a
// reminder — long investigations keep a low-frequency nudge forever.
describe('idle rule with the production backoff latch', () => {
  const backoffRule = () => createIdleRule(new ReminderLatch((fires) => Math.min(5 * 2 ** (fires - 1), 40), 1000))

  it('fires at +5, +5, +10, +20, +40, +40 — early cadence unchanged, then a low-frequency floor', () => {
    const r = backoffRule()
    const fires = []
    for (let s = 6; s <= 200; s++) {
      if (r(ctxWith({ tree: flatTree(1), currentStep: s, lastTraceStep: 1 })) !== null) fires.push(s)
    }
    expect(fires).toEqual([6, 11, 21, 41, 81, 121, 161])
  })

  it('never goes permanently silent in a long session (the 2026-08-27 live-trial regression)', () => {
    const r = backoffRule()
    let fires = 0
    for (let s = 6; s <= 20000; s++) {
      if (r(ctxWith({ tree: flatTree(1), currentStep: s, lastTraceStep: 1 })) !== null) fires++
    }
    // the old fixed cap of 5 went silent for good; ceiling + high cap keeps a 40-step floor
    expect(fires).toBeGreaterThan(50)
  })

  it('resets the backoff when the agent answers a reminder (trace update at/after the fire)', () => {
    const r = backoffRule()
    const tree = flatTree(1)
    expect(r(ctxWith({ tree, currentStep: 6, lastTraceStep: 1 }))).toContain('REMINDER')
    // answered within the firing step; the next quiet stretch starts over at +5
    expect(r(ctxWith({ tree, currentStep: 8, lastTraceStep: 6 }))).toBeNull()
    expect(r(ctxWith({ tree, currentStep: 11, lastTraceStep: 6 }))).toContain('REMINDER')
    // answered again; still +5, not the grown gap
    expect(r(ctxWith({ tree, currentStep: 16, lastTraceStep: 11 }))).toContain('REMINDER')
  })

  it('keeps the grown gap while reminders go unanswered', () => {
    const r = backoffRule()
    const tree = flatTree(1)
    expect(r(ctxWith({ tree, currentStep: 6, lastTraceStep: 1 }))).toContain('REMINDER')
    expect(r(ctxWith({ tree, currentStep: 11, lastTraceStep: 1 }))).toContain('REMINDER')
    expect(r(ctxWith({ tree, currentStep: 16, lastTraceStep: 1 }))).toBeNull()
    expect(r(ctxWith({ tree, currentStep: 21, lastTraceStep: 1 }))).toContain('REMINDER')
  })
})

// ── trace:nesting rule ───────────────────────────────────────────────────────

describe('nesting rule', () => {
  const rule = () => createNestingRule(new ReminderLatch(1, 5))

  it('silent with fewer than 3 flat steps, or without a finding', () => {
    expect(rule()(ctxWith({ tree: flatTree(2, { finding: true }) }))).toBeNull()
    expect(rule()(ctxWith({ tree: flatTree(3) }))).toBeNull()
  })

  it('fires on a flat tree with findings', () => {
    expect(rule()(ctxWith({ tree: flatTree(3, { finding: true }) }))).toContain('REMINDER')
  })

  it('silent once a step nests under another step (depth ≥ 3)', () => {
    expect(rule()(ctxWith({ tree: flatTree(4, { finding: true, nested: true }) }))).toBeNull()
  })

  it('silent once the tree is resolved', () => {
    expect(rule()(ctxWith({ tree: flatTree(3, { finding: true, resolved: true }) }))).toBeNull()
  })

  it('refires only when the flat count grows; a new tree generation re-arms it', () => {
    const r = rule()
    const t = flatTree(3, { finding: true })
    expect(r(ctxWith({ tree: t }))).toContain('REMINDER')
    // Same shape re-evaluated — no refire (regression: latch reset on replay)
    expect(r(ctxWith({ tree: t }))).toBeNull()
    // Flat count grows → refire
    expect(r(ctxWith({ tree: flatTree(4, { finding: true }) }))).toContain('REMINDER')
    // New tree (forest length grows) with its own flat shape → fires again
    const t2 = flatTree(3, { finding: true })
    expect(r(ctxWith({ tree: t2, forest: { trees: [t, t2] } }))).toContain('REMINDER')
  })
})

// ── buildReminderContext ─────────────────────────────────────────────────────

describe('buildReminderContext', () => {
  const store = () => new SessionForestStore(() => null, foldEvent, () => {})

  function agentWith(events: any[], id = 's1') {
    return { session: { id, events } }
  }

  it('returns null without a session or events', () => {
    expect(buildReminderContext({}, store())).toBeNull()
    expect(buildReminderContext(agentWith([]), store())).toBeNull()
  })

  it('derives step positions without parsing call arguments', () => {
    const s = store()
    const ctx = buildReminderContext(agentWith([
      { type: 'step/start', data: { turn: 1, step: 2 } },
      { type: 'tool/call', data: { name: 'trace', arguments: '{broken json' } },
      { type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
      { type: 'step/start', data: { turn: 1, step: 9 } },
    ]), s)!
    expect(ctx.currentStep).toBe(1009)
    expect(ctx.lastTraceStep).toBe(1002)
    expect(ctx.tree).toBeNull()
  })

  it('reads the live tree from the store', () => {
    const s = store()
    s.apply({ id: 's1' }, { action: 'create_tree', goal_title: 'G' }, 1)
    const ctx = buildReminderContext(agentWith([
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ]), s)!
    expect(ctx.tree).not.toBeNull()
    expect(ctx.tree!.nodes[0].title).toBe('G')
  })
})
