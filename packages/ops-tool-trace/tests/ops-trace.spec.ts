/**
 * Unit spec for ops-trace: drives the real plugin through a mock context,
 * covering tool execute behavior, state-machine validation, the create_tree
 * double-fold regression, render output, and export shape.
 */

import { describe, it, expect } from 'vitest'
import * as plugin from '../src/index.ts'
import { setup } from './harness.ts'
import type { ForestState } from '../src/types.ts'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-trace')
    expect(plugin.inject).toEqual(['tools'])
    expect(typeof plugin.apply).toBe('function')
    expect(typeof plugin.foldEvent).toBe('function')
    expect(plugin.Config).toBeDefined()
  })
})

// ── create_tree ──────────────────────────────────────────────────────────────

describe('create_tree', () => {
  it('creates a tree with a single goal node', async () => {
    const { run } = setup()
    const r = await run({ action: 'create_tree', goal_title: 'Pod crash' })
    expect(r.tree.nodes).toHaveLength(1)
    expect(r.tree.nodes[0]).toMatchObject({ id: 'goal', title: 'Pod crash', status: 'goal', parent: null })
    expect(r.tree.resolved).toBe(false)
  })

  it('rejects without goal_title', async () => {
    const { run } = setup()
    await expect(run({ action: 'create_tree' })).rejects.toThrow('goal_title')
  })

  it('a second create_tree appends a new tree; the old one stays as history', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'First' })
    await run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    const r = await run({ action: 'create_tree', goal_title: 'Second' })
    expect(r.tree.nodes).toHaveLength(1)
    expect(r.tree.nodes[0].title).toBe('Second')
  })
})

// ── Phantom-tree regression (create_tree double-fold) ────────────────────────

describe('create_tree seeding double-fold (phantom tree regression)', () => {
  /** The projection has already folded this very create_tree call. */
  function preFolded(title: string, turn: number): ForestState {
    return {
      trees: [{
        nodes: [{ id: 'goal', title, status: 'goal', parent: null, turns: [turn], summary: null, detail: null, caused_by: [] }],
        resolved: false,
      }],
    }
  }

  it('does not append a duplicate tree when the seed already contains this call', async () => {
    const { run } = setup({ projectionState: preFolded('G', 0) })
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    await run({ action: 'complete', id: 's1', summary: 'found' })
    await run({ action: 'resolve', id: 'goal', summary: 'done' })
    // Before the fix, view here showed the phantom goal-only tree.
    const v = await run({ action: 'view' })
    expect(v.tree.nodes.map((n) => n.id)).toEqual(['goal', 's1'])
    expect(v.tree.resolved).toBe(true)
  })

  it('still creates the tree when the seeded state is unrelated (restart case)', async () => {
    const { run } = setup({ projectionState: preFolded('Old investigation', 0) })
    const r = await run({ action: 'create_tree', goal_title: 'New investigation' })
    expect(r.tree.nodes[0].title).toBe('New investigation')
  })
})

// ── add_step / add_milestone ─────────────────────────────────────────────────

describe('add nodes', () => {
  it('stores detail and leaves summary null on add', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    const r = await run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'Ceph full', detail: '因为 osd.1 99%' })
    const m = r.tree.nodes.find((n) => n.id === 'm1')!
    expect(m.status).toBe('goal')
    expect(m.detail).toBe('因为 osd.1 99%')
    expect(m.summary).toBeNull()
  })

  it('step nests under another step', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    const r = await run({ action: 'add_step', id: 's2', parent_id: 's1', title: 'S2' })
    expect(r.tree.nodes.find((n) => n.id === 's2')!.parent).toBe('s1')
  })

  it('validates: no tree, missing fields, unknown parent, duplicate id', async () => {
    const { run } = setup()
    await expect(run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S' }))
      .rejects.toThrow('no tree')
    await run({ action: 'create_tree', goal_title: 'G' })
    await expect(run({ action: 'add_step', parent_id: 'goal', title: 'S' })).rejects.toThrow('id')
    await expect(run({ action: 'add_step', id: 's1', title: 'S' })).rejects.toThrow('parent_id')
    await expect(run({ action: 'add_step', id: 's1', parent_id: 'goal' })).rejects.toThrow('title')
    await expect(run({ action: 'add_step', id: 's1', parent_id: 'nope', title: 'S' }))
      .rejects.toThrow('not found')
    await run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S' })
    await expect(run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S again' }))
      .rejects.toThrow('already exists')
  })
})

// ── Status transitions ───────────────────────────────────────────────────────

describe('status transitions', () => {
  async function withStep() {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    return h
  }

  it('start: pending → in_progress; complete skips start; abandon → dead_end; reopen reactivates', async () => {
    const { run } = await withStep()
    expect((await run({ action: 'start', id: 's1' })).tree.nodes[1].status).toBe('in_progress')
    expect((await run({ action: 'complete', id: 's1', summary: 'ok' })).tree.nodes[1].status).toBe('done')
    expect((await run({ action: 'abandon', id: 's1' })).tree.nodes[1].status).toBe('dead_end')
    expect((await run({ action: 'reopen', id: 's1' })).tree.nodes[1].status).toBe('in_progress')
  })

  it('rejects illegal transitions (dead_end → done)', async () => {
    const { run } = await withStep()
    await run({ action: 'abandon', id: 's1' })
    await expect(run({ action: 'complete', id: 's1' })).rejects.toThrow('cannot transition')
  })

  it('accepts ids arrays for batch operations', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    await h.run({ action: 'add_step', id: 's2', parent_id: 'goal', title: 'S2' })
    const r = await h.run({ action: 'complete', ids: ['s1', 's2'], summary: 'both' })
    expect(r.tree.nodes.every((n) => n.id === 'goal' || n.status === 'done')).toBe(true)
  })

  it('complete on a milestone (goal status) marks it done — hypothesis confirmed', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1' })
    const r = await h.run({ action: 'complete', id: 'm1', summary: '证实' })
    expect(r.tree.nodes.find((n) => n.id === 'm1')!.status).toBe('done')
  })
})

// ── resolve ─────────────────────────────────────────────────────────────────

describe('resolve', () => {
  it('resolves the goal and closes the tree', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    const r = await run({ action: 'resolve', id: 'goal', summary: 'root cause found' })
    expect(r.tree.resolved).toBe(true)
    expect(r.tree.nodes[0].status).toBe('resolved')
    expect(r.tree.nodes[0].summary).toBe('root cause found')
  })

  it('rejects a milestone id with a teaching error (regression: silent no-op)', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1' })
    await expect(run({ action: 'resolve', id: 'm1', summary: 'x' }))
      .rejects.toThrow('complete')
    // The tree must NOT be resolved by the rejected call
    const v = await run({ action: 'view' })
    expect(v.tree.resolved).toBe(false)
  })

  it('rejects without summary', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await expect(run({ action: 'resolve', id: 'goal' })).rejects.toThrow('summary')
  })

  it('is idempotent when already resolved', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'resolve', id: 'goal', summary: 'done' })
    const r = await run({ action: 'resolve', id: 'goal', summary: 'done' })
    expect(r.tree.resolved).toBe(true)
  })
})

// ── link ─────────────────────────────────────────────────────────────────────

describe('link', () => {
  it('adds causal edges, single and batch, deduped', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_step', id: 'a', parent_id: 'goal', title: 'A' })
    await run({ action: 'add_step', id: 'b', parent_id: 'goal', title: 'B' })
    await run({ action: 'link', id: 'a', caused_by: 'b' })
    await run({ action: 'link', links: [{ id: 'a', caused_by: 'b' }] })
    const r = await run({ action: 'link', links: [{ id: 'b', caused_by: 'a' }] })
    expect(r.tree.nodes.find((n) => n.id === 'a')!.caused_by).toEqual(['b'])
    expect(r.tree.nodes.find((n) => n.id === 'b')!.caused_by).toEqual(['a'])
  })

  it('rejects links to unknown nodes', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_step', id: 'a', parent_id: 'goal', title: 'A' })
    await expect(run({ action: 'link', id: 'a', caused_by: 'ghost' })).rejects.toThrow('not found')
  })
})

// ── view / help ──────────────────────────────────────────────────────────────

describe('view and help', () => {
  it('view throws without a tree', async () => {
    const { run } = setup()
    await expect(run({ action: 'view' })).rejects.toThrow('no tree')
  })

  it('status_filter keeps the goal and matching nodes only', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    await run({ action: 'add_step', id: 's2', parent_id: 'goal', title: 'S2' })
    await run({ action: 'complete', id: 's1' })
    const r = await run({ action: 'view', status_filter: 'done' })
    expect(r.tree.nodes.map((n) => n.id).sort()).toEqual(['goal', 's1'])
  })

  it('help needs no tree and changes no state', async () => {
    const h = setup()
    const r = await h.run({ action: 'help' })
    expect(r.tree.nodes).toHaveLength(0)
    const text = h.render({ action: 'help' }, r)
    expect(text).toContain('触发节点')
    expect(text).toContain('step 先行')
  })
})

// ── Render output ────────────────────────────────────────────────────────────

describe('render output', () => {
  it('add_step render shows the new node, its parent, and stats', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    const r = await h.run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'Check logs', detail: 'pod events' })
    const text = h.render({ action: 'add_step', id: 's1', parent_id: 'goal' }, r)
    expect(text).toContain('+ s1: pending Check logs')
    expect(text).toContain('detail: pod events')
    expect(text).toContain('parent: goal')
    expect(text).toContain('2 nodes')
  })

  it('complete render shows status; resolve render shows resolved', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    const rc = await h.run({ action: 'complete', id: 's1' })
    expect(h.render({ action: 'complete', id: 's1' }, rc)).toContain('= s1: done')
    const rr = await h.run({ action: 'resolve', id: 'goal', summary: 'done' })
    expect(h.render({ action: 'resolve' }, rr)).toContain('= goal: resolved')
  })

  it('resolve render warns about incomplete nodes (warning was dead code)', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    const r = await h.run({ action: 'resolve', id: 'goal', summary: 'done' })
    const text = h.render({ action: 'resolve' }, r)
    expect(text).toContain('WARN: 1 node(s) still incomplete')
  })

  it('view render shows full tree with turns, detail, and summary', async () => {
    const h = setup()
    const ev = [{ type: 'turn/start', data: { turn: 3 } }]
    await h.run({ action: 'create_tree', goal_title: 'G' }, ev)
    await h.run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1', detail: '因为 X' }, ev)
    await h.run({ action: 'complete', id: 'm1', summary: '证实' }, ev)
    await h.run({ action: 'resolve', id: 'goal', summary: '收口' }, ev)
    const r = await h.run({ action: 'view' }, ev)
    const text = h.render({ action: 'view' }, r)
    expect(text).toContain('(turn 3)')
    expect(text).toContain('detail: 因为 X')
    expect(text).toContain('summary: 证实')
    expect(text).toContain('resolved')
  })
})

// ── Registration surface ─────────────────────────────────────────────────────

describe('registration surface', () => {
  it('registers the trace tool, methodology, and two reminders — but NOT the projection (ops-trace-ui owns it host-plane)', () => {
    const { tool, registeredProjections, opsPrompts } = setup()
    expect(tool.name).toBe('trace')
    expect(registeredProjections).toHaveLength(0)
    expect(opsPrompts.methodologies.map((m) => m.name)).toEqual(['trace:usage'])
    expect([...opsPrompts.reminders.keys()].sort()).toEqual(['trace:idle', 'trace:nesting'])
  })

  it('methodology text is the minimal core pointing at help (progressive disclosure)', () => {
    const { opsPrompts } = setup()
    const text = opsPrompts.methodologies[0].text
    expect(text).toContain('parent_id 的唯一规则')
    expect(text).toContain('action=help')
    expect(text.split('\n').length).toBeLessThanOrEqual(5)
  })

  it('registers nothing prompt-related when ops-prompts is absent', () => {
    const { opsPrompts } = setup({ withOpsPrompts: false })
    expect(opsPrompts.methodologies).toHaveLength(0)
    expect(opsPrompts.reminders.size).toBe(0)
  })

  it('effect cleanup clears in-process tree state', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    for (const cleanup of h.effectCleanups) cleanup()
    await expect(h.run({ action: 'view' })).rejects.toThrow('no tree')
  })
})

// ── abandon milestone (#6 regression: goal → dead_end) ──────────────────────

describe('abandon milestone (#6)', () => {
  it('abandon on a milestone (goal status) marks it dead_end; reopen reactivates it', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'Ceph full' })
    // Before the fix this threw: cannot transition "m1" from "goal" to "dead_end"
    const r = await run({ action: 'abandon', id: 'm1' })
    expect(r.tree.nodes.find((n) => n.id === 'm1')!.status).toBe('dead_end')
    const r2 = await run({ action: 'reopen', id: 'm1' })
    expect(r2.tree.nodes.find((n) => n.id === 'm1')!.status).toBe('in_progress')
  })

  it('abandon on the root goal is rejected and points at resolve', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await expect(run({ action: 'abandon', id: 'goal' })).rejects.toThrow('resolve')
    const v = await run({ action: 'view' })
    expect(v.tree.nodes[0].status).toBe('goal')
    expect(v.tree.resolved).toBe(false)
  })

  it('resolve 收口语义不受影响: works after a milestone was abandoned', async () => {
    const { run } = setup()
    await run({ action: 'create_tree', goal_title: 'G' })
    await run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1' })
    await run({ action: 'abandon', id: 'm1' })
    const r = await run({ action: 'resolve', id: 'goal', summary: 'root cause found elsewhere' })
    expect(r.tree.resolved).toBe(true)
    expect(r.tree.nodes.find((n) => n.id === 'm1')!.status).toBe('dead_end')
  })
})

// ── add_step flat-hang hint (#4) ─────────────────────────────────────────────

describe('add_step flat-hang hint (#4)', () => {
  async function withCompletedStepUnderMilestone() {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'm1', title: 'S1' })
    return h
  }

  it('hints when the milestone parent already has a completed step with summary — without blocking', async () => {
    const h = await withCompletedStepUnderMilestone()
    await h.run({ action: 'complete', id: 's1', summary: 'found X' })
    const r = await h.run({ action: 'add_step', id: 's2', parent_id: 'm1', title: 'S2' })
    expect(r.hint).toContain('s1')
    // Not blocked: the step is created, flat under the milestone
    expect(r.tree.nodes.find((n) => n.id === 's2')!.parent).toBe('m1')
    const text = h.render({ action: 'add_step', id: 's2', parent_id: 'm1' }, r)
    expect(text).toContain('提示')
    expect(text).toContain('s1')
  })

  it('stays silent when the completed step has no summary', async () => {
    const h = await withCompletedStepUnderMilestone()
    await h.run({ action: 'complete', id: 's1' }) // no summary — no recorded finding
    const r = await h.run({ action: 'add_step', id: 's2', parent_id: 'm1', title: 'S2' })
    expect(r.hint).toBeUndefined()
  })

  it('stays silent when the milestone has no completed steps yet', async () => {
    const h = await withCompletedStepUnderMilestone()
    const r = await h.run({ action: 'add_step', id: 's2', parent_id: 'm1', title: 'S2' })
    expect(r.hint).toBeUndefined()
  })

  it('stays silent when the parent is the root goal', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' })
    await h.run({ action: 'complete', id: 's1', summary: 'found X' })
    const r = await h.run({ action: 'add_step', id: 's2', parent_id: 'goal', title: 'S2' })
    expect(r.hint).toBeUndefined()
  })

  it('does not fire for add_milestone', async () => {
    const h = await withCompletedStepUnderMilestone()
    await h.run({ action: 'complete', id: 's1', summary: 'found X' })
    const r = await h.run({ action: 'add_milestone', id: 'm2', parent_id: 'm1', title: 'M2' })
    expect(r.hint).toBeUndefined()
  })
})

// ── view format=tree (#5) ────────────────────────────────────────────────────

describe('view format=tree (#5)', () => {
  async function withTree() {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_milestone', id: 'm1', parent_id: 'goal', title: 'M1' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'm1', title: 'S1' })
    return h
  }

  it('renders an indented outline: one line per node, two spaces per depth', async () => {
    const h = await withTree()
    const r = await h.run({ action: 'view', format: 'tree' })
    const text = h.render({ action: 'view', format: 'tree' }, r)
    expect(text).toBe(['goal: G', '  m1: M1', '    s1: pending S1'].join('\n'))
  })

  it('default view is unchanged: full render with connectors, detail and summary', async () => {
    const h = setup()
    await h.run({ action: 'create_tree', goal_title: 'G' })
    await h.run({ action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1', detail: 'pod events' })
    const r = await h.run({ action: 'view' })
    const def = h.render({ action: 'view' }, r)
    const explicit = h.render({ action: 'view', format: 'full' }, r)
    expect(def).toBe(explicit)
    expect(def).toContain('└──')
    expect(def).toContain('detail: pod events')
  })

  it('combines with status_filter', async () => {
    const h = await withTree()
    const r = await h.run({ action: 'view', format: 'tree', status_filter: 'pending' })
    const text = h.render({ action: 'view', format: 'tree' }, r)
    expect(text).toBe(['goal: G', 's1: pending S1'].join('\n'))
  })
})
