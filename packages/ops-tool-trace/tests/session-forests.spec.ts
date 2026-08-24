/**
 * SessionForestStore specs: seeding protocol, mutation critical section,
 * the create_tree double-fold guard, and failure reporting.
 *
 * The store is driven directly with the real foldEvent — no cordis runtime.
 */

import { describe, it, expect } from 'vitest'
import { SessionForestStore } from '../src/session-forests.ts'
import { foldEvent } from '../src/index.ts'
import type { ForestState } from '../src/types.ts'

function makeStore(snapshot: (session: { id: string }) => ForestState | null) {
  const warnings: string[] = []
  const store = new SessionForestStore(snapshot, foldEvent, (m) => warnings.push(m))
  return { store, warnings }
}

const emptySnapshot = () => null

function oneTreeForest(title: string, turn: number, resolved = false): ForestState {
  return {
    trees: [{
      nodes: [{ id: 'goal', title, status: resolved ? 'resolved' : 'goal', parent: null, turns: [turn], summary: null, detail: null, caused_by: [] }],
      resolved,
    }],
  }
}

const S = (id: string) => ({ id })

// ── Seeding ──────────────────────────────────────────────────────────────────

describe('seeding', () => {
  it('starts empty when the projection has nothing', () => {
    const { store } = makeStore(emptySnapshot)
    const { forest, seeded } = store.current(S('a'))
    expect(forest.trees).toHaveLength(0)
    expect(seeded).toBe(false)
  })

  it('seeds from the projection on first access', () => {
    const { store } = makeStore(() => oneTreeForest('G', 1))
    const { forest, seeded } = store.current(S('a'))
    expect(seeded).toBe(true)
    expect(forest.trees).toHaveLength(1)
  })

  it('the map is authoritative after seeding — no re-snapshot', () => {
    let calls = 0
    const { store } = makeStore(() => { calls++; return oneTreeForest('G', 1) })
    store.current(S('a'))
    store.current(S('a'))
    expect(calls).toBe(1)
  })

  it('sessions are isolated by id', () => {
    const { store } = makeStore((s) => oneTreeForest(`tree-of-${s.id}`, 1))
    expect(store.current(S('a')).forest.trees[0].nodes[0].title).toBe('tree-of-a')
    expect(store.current(S('b')).forest.trees[0].nodes[0].title).toBe('tree-of-b')
  })
})

// ── Mutation critical section ────────────────────────────────────────────────

describe('apply', () => {
  it('folds and persists; sequential calls see each other immediately', () => {
    const { store } = makeStore(emptySnapshot)
    store.apply(S('a'), { action: 'create_tree', goal_title: 'G' }, 1)
    const forest = store.apply(S('a'), { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' }, 1)
    expect(forest.trees[0].nodes).toHaveLength(2)
    expect(store.current(S('a')).forest.trees[0].nodes).toHaveLength(2)
  })

  it('apply after seeding continues from the seeded state', () => {
    const { store } = makeStore(() => oneTreeForest('G', 1))
    const forest = store.apply(S('a'), { action: 'add_step', id: 's1', parent_id: 'goal', title: 'S1' }, 2)
    expect(forest.trees[0].nodes).toHaveLength(2)
  })
})

// ── Phantom-tree guard ───────────────────────────────────────────────────────

describe('create_tree double-fold guard', () => {
  it('does not append a duplicate when the seed already contains this very call', () => {
    // The projection folded this create_tree before execute ran
    const { store } = makeStore(() => oneTreeForest('G', 3))
    const forest = store.apply(S('a'), { action: 'create_tree', goal_title: 'G' }, 3)
    expect(forest.trees).toHaveLength(1)
  })

  it('still appends when the seeded tree is from a different call (restart case)', () => {
    const { store } = makeStore(() => oneTreeForest('Old', 1))
    const forest = store.apply(S('a'), { action: 'create_tree', goal_title: 'New' }, 5)
    expect(forest.trees).toHaveLength(2)
  })

  it('still appends when the matching tree was resolved (new investigation, same title)', () => {
    const { store } = makeStore(() => oneTreeForest('G', 1, true))
    const forest = store.apply(S('a'), { action: 'create_tree', goal_title: 'G' }, 5)
    expect(forest.trees).toHaveLength(2)
  })
})

// ── Failure reporting ────────────────────────────────────────────────────────

describe('projection failure', () => {
  it('warns loudly, once per session, and starts empty', () => {
    const { store, warnings } = makeStore(() => { throw new Error('projection down') })
    const { forest } = store.current(S('a'))
    expect(forest.trees).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('projection seed failed')
    store.current(S('a'))
    expect(warnings).toHaveLength(1) // no repeat nag
    // another session reports its own failure
    store.current(S('b'))
    expect(warnings).toHaveLength(2)
  })
})

// ── Teardown ─────────────────────────────────────────────────────────────────

describe('clear', () => {
  it('drops all in-process state; next access re-seeds', () => {
    const { store } = makeStore(() => oneTreeForest('G', 1))
    store.apply(S('a'), { action: 'create_tree', goal_title: 'G' }, 5)
    store.clear()
    const { forest, seeded } = store.current(S('a'))
    expect(seeded).toBe(true)
    expect(forest.trees[0].nodes).toHaveLength(1)
  })
})
