/**
 * Tree layout tests — the shared pure module behind both the host renderers
 * (what the model sees) and the web client (what the human sees). Both sides
 * import these functions, so this spec is also the web client's layout
 * coverage: it pins the ordering both audiences look at.
 */

import { describe, it, expect } from 'vitest'
import { buildTreeIndex, depthOf, flattenTree, sortChildren } from '../src/tree-layout.ts'
import type { TreeNode } from '../src/types.ts'

function node(id: string, parent: string | null, status: TreeNode['status'] = 'pending'): TreeNode {
  return { id, title: id, status, parent, turns: [], summary: null, detail: null, caused_by: [] }
}

describe('buildTreeIndex', () => {
  it('groups children by parent and finds the root', () => {
    const nodes = [node('goal', null, 'goal'), node('m1', 'goal'), node('s1', 'm1')]
    const { children, root } = buildTreeIndex(nodes)
    expect(root?.id).toBe('goal')
    expect(children['goal'].map((n) => n.id)).toEqual(['m1'])
    expect(children['m1'].map((n) => n.id)).toEqual(['s1'])
  })

  it('returns null root when no root exists', () => {
    const { root } = buildTreeIndex([node('a', 'missing')])
    expect(root).toBeNull()
  })
})

describe('sortChildren', () => {
  it('orders by status: in_progress, pending, done, dead_end; goal id last', () => {
    const sorted = sortChildren([
      node('goal', 'x', 'goal'),
      node('d1', 'x', 'done'),
      node('p1', 'x', 'pending'),
      node('a1', 'x', 'in_progress'),
      node('z1', 'x', 'dead_end'),
    ])
    expect(sorted.map((n) => n.id)).toEqual(['a1', 'p1', 'd1', 'z1', 'goal'])
  })

  it('is stable for equal statuses and does not mutate the input', () => {
    const input = [node('a', 'x', 'pending'), node('b', 'x', 'pending')]
    const sorted = sortChildren(input)
    expect(sorted.map((n) => n.id)).toEqual(['a', 'b'])
    expect(input.map((n) => n.id)).toEqual(['a', 'b'])
  })
})

describe('depthOf', () => {
  it('computes depth via the parent chain, root = 0', () => {
    const nodes = [node('goal', null), node('m1', 'goal'), node('s1', 'm1'), node('s2', 's1')]
    expect(depthOf(nodes, 'goal')).toBe(0)
    expect(depthOf(nodes, 'm1')).toBe(1)
    expect(depthOf(nodes, 's1')).toBe(2)
    expect(depthOf(nodes, 's2')).toBe(3)
  })

  it('stops on a parent cycle instead of looping forever', () => {
    // a → b → a: two edges walked, then the cycle is detected and stops.
    const nodes = [node('a', 'b'), node('b', 'a')]
    expect(depthOf(nodes, 'a')).toBe(2)
  })

  it('shares a cache across calls', () => {
    const nodes = [node('goal', null), node('m1', 'goal')]
    const cache: Record<string, number> = {}
    depthOf(nodes, 'm1', cache)
    expect(cache['m1']).toBe(1)
    expect(depthOf(nodes, 'm1', cache)).toBe(1)
  })
})

describe('flattenTree', () => {
  it('DFS: children follow their parent, siblings status-sorted', () => {
    const nodes = [
      node('goal', null, 'goal'),
      node('m-done', 'goal', 'done'),
      node('m-active', 'goal', 'in_progress'),
      node('s1', 'm-active', 'pending'),
    ]
    expect(flattenTree(nodes).map((n) => n.id)).toEqual(['goal', 'm-active', 's1', 'm-done'])
  })

  it('appends orphans instead of dropping them', () => {
    const nodes = [node('goal', null, 'goal'), node('orphan', 'missing')]
    expect(flattenTree(nodes).map((n) => n.id)).toEqual(['goal', 'orphan'])
  })

  it('does not loop on a parent cycle', () => {
    const nodes = [node('goal', null, 'goal'), node('a', 'b'), node('b', 'a')]
    expect(flattenTree(nodes).map((n) => n.id).sort()).toEqual(['a', 'b', 'goal'])
  })
})
