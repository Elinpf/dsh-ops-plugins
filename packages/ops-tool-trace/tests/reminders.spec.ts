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
