/**
 * Projection fold tests for ops-todo-tree.
 *
 * Validates that foldEvent correctly builds TreeState from incremental events.
 * These are pure-function tests — no Cordis runtime needed.
 */

import { describe, it, expect } from 'vitest'
import { foldEvent } from '../src/index.ts'
import type { TreeState } from '../src/types.ts'

// Helper: build a tree from a sequence of events
function foldAll(events: any[]): TreeState | null {
  let state: TreeState | null = null
  for (const event of events) {
    state = foldEvent(state, event)
  }
  return state
}

describe('projection fold', () => {
  it('initial state is null', () => {
    expect(foldEvent(null, { type: 'other/event' })).toBe(null)
  })

  it('ignores unrelated events', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: {} },
    ]
    expect(foldAll(events)).toBe(null)
  })

  it('create_tree builds root + goal', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: {
        turn: 1, root_id: 'root', root_title: 'Pod crashing',
        goal_id: 'goal', goal_title: 'Service recovered',
      } },
    ])
    expect(state).not.toBeNull()
    expect(state!.nodes).toHaveLength(2)
    expect(state!.resolved).toBe(false)

    const root = state!.nodes.find((n) => n.id === 'root')
    expect(root).toBeDefined()
    expect(root!.title).toBe('Pod crashing')
    expect(root!.status).toBe('goal')
    expect(root!.parent).toBeNull()
    expect(root!.turns).toEqual([1])

    const goal = state!.nodes.find((n) => n.id === 'goal')
    expect(goal).toBeDefined()
    expect(goal!.title).toBe('Service recovered')
    expect(goal!.status).toBe('goal')
    expect(goal!.parent).toBe('root')
  })

  it('add_step creates a pending step', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/add', data: { turn: 1, node_id: 'n1', parent_id: 'root', title: 'Check logs', kind: 'step', branch: false } },
    ])
    const step = state!.nodes.find((n) => n.id === 'n1')
    expect(step).toBeDefined()
    expect(step!.status).toBe('pending')
    expect(step!.parent).toBe('root')
    expect(step!.turns).toEqual([1])
  })

  it('add_milestone creates a goal-status milestone', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/add', data: { turn: 2, node_id: 'm1', parent_id: 'root', title: 'Confirm root cause', kind: 'milestone', branch: false } },
    ])
    const milestone = state!.nodes.find((n) => n.id === 'm1')
    expect(milestone!.status).toBe('goal')
  })

  it('start transitions pending → in_progress', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/add', data: { turn: 1, node_id: 'n1', parent_id: 'root', title: 'Step 1', kind: 'step', branch: false } },
      { type: 'todo_tree/start', data: { turn: 2, node_id: 'n1' } },
    ])
    const node = state!.nodes.find((n) => n.id === 'n1')
    expect(node!.status).toBe('in_progress')
    expect(node!.turns).toContain(2)
  })

  it('complete transitions in_progress → done', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/add', data: { turn: 1, node_id: 'n1', parent_id: 'root', title: 'Step 1', kind: 'step', branch: false } },
      { type: 'todo_tree/start', data: { turn: 2, node_id: 'n1' } },
      { type: 'todo_tree/complete', data: { turn: 3, node_id: 'n1' } },
    ])
    expect(state!.nodes.find((n) => n.id === 'n1')!.status).toBe('done')
  })

  it('abandon transitions in_progress → dead_end', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/add', data: { turn: 1, node_id: 'n1', parent_id: 'root', title: 'Step 1', kind: 'step', branch: false } },
      { type: 'todo_tree/start', data: { turn: 2, node_id: 'n1' } },
      { type: 'todo_tree/abandon', data: { turn: 3, node_id: 'n1' } },
    ])
    expect(state!.nodes.find((n) => n.id === 'n1')!.status).toBe('dead_end')
  })

  it('dead_end can be re-started (non-terminal)', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/add', data: { turn: 1, node_id: 'n1', parent_id: 'root', title: 'Step 1', kind: 'step', branch: false } },
      { type: 'todo_tree/start', data: { turn: 2, node_id: 'n1' } },
      { type: 'todo_tree/abandon', data: { turn: 3, node_id: 'n1' } },
      { type: 'todo_tree/start', data: { turn: 4, node_id: 'n1' } },
    ])
    expect(state!.nodes.find((n) => n.id === 'n1')!.status).toBe('in_progress')
  })

  it('resolve sets summary and resolved flag', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/resolve', data: { turn: 5, goal_id: 'goal', summary: 'OOM — increased memory limit' } },
    ])
    expect(state!.resolved).toBe(true)
    const goal = state!.nodes.find((n) => n.id === 'goal')
    expect(goal!.status).toBe('resolved')
    expect(goal!.summary).toBe('OOM — increased memory limit')
  })

  it('note adds detail to a node', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
      { type: 'todo_tree/add', data: { turn: 1, node_id: 'n1', parent_id: 'root', title: 'Step 1', kind: 'step', branch: false } },
      { type: 'todo_tree/note', data: { turn: 2, node_id: 'n1', detail: 'kubectl logs showed OOMKilled' } },
    ])
    expect(state!.nodes.find((n) => n.id === 'n1')!.detail).toBe('kubectl logs showed OOMKilled')
  })

  it('fold is a pure function (does not mutate input)', () => {
    const state1 = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'P', goal_id: 'goal', goal_title: 'G' } },
    ])
    const nodesBefore = state1!.nodes.length
    const state2 = foldEvent(state1, {
      type: 'todo_tree/add', data: { turn: 2, node_id: 'n1', parent_id: 'root', title: 'Step', kind: 'step', branch: false },
    })
    // Original state unchanged
    expect(state1!.nodes).toHaveLength(nodesBefore)
    // New state has the added node
    expect(state2!.nodes).toHaveLength(nodesBefore + 1)
    // Different references
    expect(state1).not.toBe(state2)
    expect(state1!.nodes).not.toBe(state2!.nodes)
  })

  it('full scenario: create → branch → dead_end → resolve', () => {
    const state = foldAll([
      { type: 'todo_tree/create', data: { turn: 1, root_id: 'root', root_title: 'Pod crashing', goal_id: 'goal', goal_title: 'Service recovered' } },
      { type: 'todo_tree/add', data: { turn: 1, node_id: 'A', parent_id: 'root', title: 'Check logs', kind: 'step', branch: false } },
      { type: 'todo_tree/start', data: { turn: 2, node_id: 'A' } },
      { type: 'todo_tree/complete', data: { turn: 3, node_id: 'A' } },
      { type: 'todo_tree/add', data: { turn: 3, node_id: 'B', parent_id: 'A', title: 'Check events', kind: 'step', branch: false } },
      { type: 'todo_tree/start', data: { turn: 4, node_id: 'B' } },
      { type: 'todo_tree/complete', data: { turn: 5, node_id: 'B' } },
      { type: 'todo_tree/add', data: { turn: 5, node_id: 'C', parent_id: 'B', title: 'Edit deployment', kind: 'step', branch: true } },
      { type: 'todo_tree/start', data: { turn: 5, node_id: 'C' } },
      { type: 'todo_tree/abandon', data: { turn: 6, node_id: 'C' } },
      { type: 'todo_tree/add', data: { turn: 6, node_id: 'D', parent_id: 'B', title: 'Check resources', kind: 'step', branch: true } },
      { type: 'todo_tree/start', data: { turn: 7, node_id: 'D' } },
      { type: 'todo_tree/complete', data: { turn: 8, node_id: 'D' } },
      { type: 'todo_tree/add', data: { turn: 8, node_id: 'M', parent_id: 'D', title: 'Confirm OOM', kind: 'milestone', branch: false } },
      { type: 'todo_tree/complete', data: { turn: 9, node_id: 'M' } },
      { type: 'todo_tree/resolve', data: { turn: 10, goal_id: 'goal', summary: 'OOM — increased memory limit from 256Mi to 512Mi' } },
    ])

    expect(state!.nodes).toHaveLength(8)
    expect(state!.resolved).toBe(true)

    const dead = state!.nodes.find((n) => n.id === 'C')
    expect(dead!.status).toBe('dead_end')

    const goal = state!.nodes.find((n) => n.id === 'goal')
    expect(goal!.status).toBe('resolved')
    expect(goal!.summary).toBe('OOM — increased memory limit from 256Mi to 512Mi')
  })
})
