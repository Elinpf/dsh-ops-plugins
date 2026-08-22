/**
 * Projection fold tests for ops-trace.
 *
 * Validates that foldEvent correctly builds TreeState from tool/call events.
 * These are pure-function tests — no Cordis runtime needed.
 */

import { describe, it, expect } from 'vitest'
import { foldEvent } from '../src/index.ts'
import type { TreeState } from '../src/types.ts'

/** Build a tool/call event for trace with the given action args. */
function ev(turn: number, args: Record<string, unknown>) {
  return {
    type: 'tool/call',
    data: { name: 'trace', turn, arguments: JSON.stringify(args) },
  }
}

/** Fold a sequence of action args into a TreeState. */
function foldAll(actions: Array<{ turn: number, args: Record<string, unknown> }>): TreeState | null {
  let state: TreeState | null = null
  for (const { turn, args } of actions) {
    state = foldEvent(state, ev(turn, args))
  }
  return state
}

// ── Basic structure ──────────────────────────────────────────────────────────

describe('projection fold', () => {
  it('null state stays null on unrelated events', () => {
    expect(foldEvent(null, { type: 'turn/start', data: { turn: 1 } })).toBe(null)
    expect(foldEvent(null, { type: 'user/message', data: {} })).toBe(null)
  })

  it('ignores non-trace tool calls', () => {
    const state = foldEvent(null, {
      type: 'tool/call',
      data: { name: 'bash', turn: 1, arguments: '{"command":"ls"}' },
    })
    expect(state).toBe(null)
  })

  it('create_tree builds goal node', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'Pod crashing' } },
    ])
    expect(state).not.toBeNull()
    expect(state!.nodes).toHaveLength(1)
    expect(state!.resolved).toBe(false)

    const goal = state!.nodes[0]
    expect(goal.id).toBe('goal')
    expect(goal.title).toBe('Pod crashing')
    expect(goal.status).toBe('goal')
    expect(goal.parent).toBeNull()
    expect(goal.turns).toEqual([1])
    expect(goal.caused_by).toEqual([])
  })

  it('create_tree is idempotent on replay', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'A' } },
      { turn: 2, args: { action: 'create_tree', goal_title: 'A' } },
    ])
    expect(state!.nodes).toHaveLength(1)
    expect(state!.nodes[0].title).toBe('A')
  })
})

// ── Add nodes ────────────────────────────────────────────────────────────────

describe('add nodes', () => {
  it('add_milestone creates a goal-status node under goal', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'Phase 1' } },
    ])
    const m = state!.nodes.find((n) => n.id === 'm1')
    expect(m).toBeDefined()
    expect(m!.status).toBe('goal')
    expect(m!.parent).toBe('goal')
    expect(m!.turns).toEqual([1])
  })

  it('add_step creates a pending node', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1' } },
      { turn: 2, args: { action: 'add_step', id: 's1', parent_id: 'm1', title: 'Check logs' } },
    ])
    const s = state!.nodes.find((n) => n.id === 's1')
    expect(s).toBeDefined()
    expect(s!.status).toBe('pending')
    expect(s!.parent).toBe('m1')
    expect(s!.turns).toEqual([2])
  })

  it('add_step can nest under another step', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
      { turn: 2, args: { action: 'add_step', id: 's2', parent_id: 's1', title: 'S2' } },
    ])
    expect(state!.nodes.find((n) => n.id === 's2')!.parent).toBe('s1')
  })
})

// ── Status transitions ──────────────────────────────────────────────────────

describe('status transitions', () => {
  function buildWithStep() {
    return foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
    ])
  }

  it('start: pending → in_progress', () => {
    const state = foldEvent(buildWithStep(), ev(2, { action: 'start', id: 's1' }))
    expect(state!.nodes.find((n) => n.id === 's1')!.status).toBe('in_progress')
    expect(state!.nodes.find((n) => n.id === 's1')!.turns).toContain(2)
  })

  it('complete: pending → done (skips start)', () => {
    const state = foldEvent(buildWithStep(), ev(2, { action: 'complete', id: 's1' }))
    expect(state!.nodes.find((n) => n.id === 's1')!.status).toBe('done')
  })

  it('complete with summary stores it', () => {
    const state = foldEvent(buildWithStep(), ev(2, { action: 'complete', id: 's1', summary: 'Found OOM' }))
    expect(state!.nodes.find((n) => n.id === 's1')!.summary).toBe('Found OOM')
  })

  it('abandon: pending → dead_end', () => {
    const state = foldEvent(buildWithStep(), ev(2, { action: 'abandon', id: 's1' }))
    expect(state!.nodes.find((n) => n.id === 's1')!.status).toBe('dead_end')
  })

  it('reopen: done → in_progress', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
      { turn: 2, args: { action: 'complete', id: 's1' } },
      { turn: 3, args: { action: 'reopen', id: 's1' } },
    ])
    expect(state!.nodes.find((n) => n.id === 's1')!.status).toBe('in_progress')
  })

  it('reopen: dead_end → in_progress', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
      { turn: 2, args: { action: 'abandon', id: 's1' } },
      { turn: 3, args: { action: 'reopen', id: 's1' } },
    ])
    expect(state!.nodes.find((n) => n.id === 's1')!.status).toBe('in_progress')
  })

  it('start accepts ids array (batch)', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
      { turn: 1, args: { action: 'add_step', id: 's2', parent_id: 'goal', title: 'S2' } },
      { turn: 2, args: { action: 'start', ids: ['s1', 's2'] } },
    ])
    expect(state!.nodes.find((n) => n.id === 's1')!.status).toBe('in_progress')
    expect(state!.nodes.find((n) => n.id === 's2')!.status).toBe('in_progress')
  })

  it('complete accepts ids array (batch)', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
      { turn: 1, args: { action: 'add_step', id: 's2', parent_id: 'goal', title: 'S2' } },
      { turn: 2, args: { action: 'complete', ids: ['s1', 's2'], summary: 'both done' } },
    ])
    expect(state!.nodes.find((n) => n.id === 's1')!.status).toBe('done')
    expect(state!.nodes.find((n) => n.id === 's2')!.status).toBe('done')
    expect(state!.nodes.find((n) => n.id === 's1')!.summary).toBe('both done')
  })
})

// ── Link (causal edges) ──────────────────────────────────────────────────────

describe('link', () => {
  it('single link adds caused_by edge', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
      { turn: 1, args: { action: 'add_step', id: 's2', parent_id: 'goal', title: 'S2' } },
      { turn: 2, args: { action: 'link', id: 's1', caused_by: 's2' } },
    ])
    expect(state!.nodes.find((n) => n.id === 's1')!.caused_by).toEqual(['s2'])
  })

  it('batch link via links array', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 'a', parent_id: 'goal', title: 'A' } },
      { turn: 1, args: { action: 'add_step', id: 'b', parent_id: 'goal', title: 'B' } },
      { turn: 1, args: { action: 'add_step', id: 'c', parent_id: 'goal', title: 'C' } },
      { turn: 2, args: { action: 'link', links: [
        { id: 'a', caused_by: 'c' },
        { id: 'b', caused_by: 'c' },
      ] } },
    ])
    expect(state!.nodes.find((n) => n.id === 'a')!.caused_by).toEqual(['c'])
    expect(state!.nodes.find((n) => n.id === 'b')!.caused_by).toEqual(['c'])
  })

  it('duplicate link does not duplicate caused_by entry', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 'a', parent_id: 'goal', title: 'A' } },
      { turn: 1, args: { action: 'add_step', id: 'b', parent_id: 'goal', title: 'B' } },
      { turn: 2, args: { action: 'link', id: 'a', caused_by: 'b' } },
      { turn: 3, args: { action: 'link', id: 'a', caused_by: 'b' } },
    ])
    expect(state!.nodes.find((n) => n.id === 'a')!.caused_by).toEqual(['b'])
  })
})

// ── Resolve ─────────────────────────────────────────────────────────────────

describe('resolve', () => {
  it('sets goal status to resolved and flag', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 5, args: { action: 'resolve', summary: 'Ceph was full' } },
    ])
    expect(state!.resolved).toBe(true)
    const goal = state!.nodes.find((n) => n.id === 'goal')
    expect(goal!.status).toBe('resolved')
    expect(goal!.summary).toBe('Ceph was full')
  })
})

// ── Purity ──────────────────────────────────────────────────────────────────

describe('purity', () => {
  it('does not mutate input state', () => {
    const state1 = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'G' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' } },
    ])
    const nodesBefore = state1!.nodes.length
    const state2 = foldEvent(state1, ev(2, { action: 'add_step', id: 's2', parent_id: 'goal', title: 'S2' }))

    expect(state1!.nodes).toHaveLength(nodesBefore)
    expect(state2!.nodes).toHaveLength(nodesBefore + 1)
    expect(state1).not.toBe(state2)
    expect(state1!.nodes).not.toBe(state2!.nodes)
  })
})

// ── Full scenario ───────────────────────────────────────────────────────────

describe('full scenario', () => {
  it('create → investigate → dead end → resolve', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'Pod crash' } },
      { turn: 1, args: { action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'Find root cause' } },
      { turn: 1, args: { action: 'add_step', id: 's1', parent_id: 'm1', title: 'Check logs' } },
      { turn: 2, args: { action: 'start', id: 's1' } },
      { turn: 3, args: { action: 'complete', id: 's1', summary: 'OOMKilled' } },
      { turn: 3, args: { action: 'add_step', id: 's2', parent_id: 'm1', title: 'Check events' } },
      { turn: 4, args: { action: 'start', id: 's2' } },
      { turn: 4, args: { action: 'abandon', id: 's2' } },
      { turn: 5, args: { action: 'resolve', summary: 'OOM — increased memory limit' } },
    ])

    expect(state!.nodes).toHaveLength(4) // goal, m1, s1, s2
    expect(state!.resolved).toBe(true)

    const s1 = state!.nodes.find((n) => n.id === 's1')
    expect(s1!.status).toBe('done')
    expect(s1!.summary).toBe('OOMKilled')

    const s2 = state!.nodes.find((n) => n.id === 's2')
    expect(s2!.status).toBe('dead_end')

    const goal = state!.nodes.find((n) => n.id === 'goal')
    expect(goal!.status).toBe('resolved')
  })

  it('causal chain: ceph-full → csi-lock → pod-stuck → downstream', () => {
    const state = foldAll([
      { turn: 1, args: { action: 'create_tree', goal_title: 'Multi-pod failure' } },
      { turn: 1, args: { action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'Storage' } },
      { turn: 1, args: { action: 'add_milestone', id: 'm2', parent_id: 'goal', title: 'Pods' } },
      { turn: 1, args: { action: 'add_step', id: 'ceph-full', parent_id: 'm1', title: 'Ceph full' } },
      { turn: 1, args: { action: 'add_step', id: 'csi-lock', parent_id: 'm1', title: 'CSI lock' } },
      { turn: 1, args: { action: 'add_step', id: 'pod-stuck', parent_id: 'm2', title: 'Pod ContainerCreating' } },
      { turn: 1, args: { action: 'add_step', id: 'downstream', parent_id: 'm2', title: 'Downstream 503' } },
      { turn: 2, args: { action: 'complete', ids: ['ceph-full', 'csi-lock', 'pod-stuck', 'downstream'] } },
      { turn: 3, args: { action: 'link', links: [
        { id: 'csi-lock', caused_by: 'ceph-full' },
        { id: 'pod-stuck', caused_by: 'csi-lock' },
        { id: 'downstream', caused_by: 'pod-stuck' },
      ] } },
      { turn: 4, args: { action: 'resolve', summary: 'Ceph full → CSI lock → pods stuck → downstream 503' } },
    ])

    expect(state!.nodes.find((n) => n.id === 'csi-lock')!.caused_by).toEqual(['ceph-full'])
    expect(state!.nodes.find((n) => n.id === 'pod-stuck')!.caused_by).toEqual(['csi-lock'])
    expect(state!.nodes.find((n) => n.id === 'downstream')!.caused_by).toEqual(['pod-stuck'])
    expect(state!.resolved).toBe(true)
  })
})
