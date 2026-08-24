/**
 * Tree layout — the single pure module for turning a flat node list into a
 * displayable tree.
 *
 * Before this module, the traversal machinery was written three times: the
 * host renderers (src/index.ts) had buildTreeIndex/sortChildren, the web
 * client (src/client.ts) had its own depthOf/treeOrder, and the reminder
 * rules (src/reminders.ts) had a third depthOf. Worse, the two displays
 * disagreed: the model saw siblings status-sorted (active work first) while
 * the human saw insertion order — the same tree, two layouts. Now both sides
 * share these functions, so the human sees the tree in the same order the
 * model reasoned about it.
 *
 * Everything here is a pure function of the node list — safe to call from
 * render paths that re-run on session-log replay.
 *
 * @module @deepseek-ai/dsh-ops-trace/tree-layout
 */

import type { TreeNode } from './types.js'

/** Status → display rank: active work first, done/dead after, goal last. */
export const STATUS_ORDER: Record<string, number> = {
  in_progress: 0, pending: 1, done: 2, dead_end: 3, goal: 4, resolved: 5,
}

/** Sort siblings: in_progress first, then pending, done, dead_end; the goal
 *  node (convergence terminal) always last. */
export function sortChildren(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    const aIsGoal = a.id === 'goal'
    const bIsGoal = b.id === 'goal'
    if (aIsGoal && !bIsGoal) return 1
    if (!aIsGoal && bIsGoal) return -1
    return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
  })
}

/** Build child map and find root from a flat node list. */
export function buildTreeIndex(nodes: TreeNode[]) {
  const children: Record<string, TreeNode[]> = {}
  let root: TreeNode | null = null
  for (const n of nodes) {
    if (n.parent === null) {
      root = n
    } else {
      if (!children[n.parent]) children[n.parent] = []
      children[n.parent].push(n)
    }
  }
  return { children, root }
}

/**
 * Depth of a node via its parent chain (root = 0). Cycle-safe: a parent loop
 * stops instead of recursing forever. Callers computing depths for many
 * nodes in one pass may share a `cache` across calls.
 */
export function depthOf(nodes: TreeNode[], id: string, cache: Record<string, number> = {}): number {
  if (id in cache) return cache[id]
  let depth = 0
  let current = nodes.find((n) => n.id === id)
  const seen = new Set<string>()
  while (current && current.parent !== null && !seen.has(current.id)) {
    seen.add(current.id)
    depth++
    current = nodes.find((n) => n.id === current!.parent)
  }
  cache[id] = depth
  return depth
}

/**
 * DFS flattening for display: children follow their parent, siblings in
 * sortChildren order. Orphans (parent id not present in the list) are
 * appended at the end so no node is ever dropped from view.
 */
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const { children, root } = buildTreeIndex(nodes)
  const result: TreeNode[] = []
  const visited = new Set<TreeNode>()
  function visit(node: TreeNode): void {
    if (visited.has(node)) return
    visited.add(node)
    result.push(node)
    const kids = children[node.id]
    if (kids) for (const k of sortChildren(kids)) visit(k)
  }
  if (root) visit(root)
  for (const n of nodes) {
    if (!visited.has(n)) result.push(n)
  }
  return result
}
