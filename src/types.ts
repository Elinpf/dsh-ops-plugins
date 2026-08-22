/**
 * Type definitions for the ops-todo-tree plugin.
 *
 * @module @deepseek-ai/dsh-ops-todo-tree
 */

// ── Node status (05 state machine) ──────────────────────────────────────────

/**
 * The six node statuses from the state machine.
 *
 * - `goal` — a stable target (milestone or final goal); uses dashed connectors
 * - `pending` — a step not yet started; uses thin dashed connectors
 * - `in_progress` — actively being worked on
 * - `done` — completed
 * - `dead_end` — proven unviable; NOT a terminal state (can re-explore)
 * - `resolved` — final goal achieved; terminal state
 */
export type NodeStatus = 'goal' | 'pending' | 'in_progress' | 'done' | 'dead_end' | 'resolved'

// ── Tree node (projection state) ─────────────────────────────────────────────

/**
 * A single node in the investigation tree.
 * Lane and depth are NOT stored here — they are derived client-side.
 */
export interface TreeNode {
  /** Unique id. The root node has id 'goal'. */
  id: string
  /** One-line description of this node. */
  title: string
  /** Current status per the 05 state machine. */
  status: NodeStatus
  /** Parent node id; `null` for the goal node (tree root). */
  parent: string | null
  /** Turns that operated on this node. */
  turns: number[]
  /** Resolution summary (written by `complete` or `resolve`). */
  summary: string | null
  /** Causal edges: other node ids that are the root cause of this node. */
  caused_by: string[]
}

/**
 * The full tree state carried in a projection snapshot.
 */
export interface TreeState {
  /** All nodes in the tree. */
  nodes: TreeNode[]
  /** Whether the final goal has been resolved. */
  resolved: boolean
}

// ── Session events (incremental, append-only) ────────────────────────────────

// ── Tool action types ────────────────────────────────────────────────────────

/** The 10 actions the `todo_tree` tool accepts. */
export type TodoTreeAction =
  | 'create_tree'
  | 'add_step'
  | 'add_milestone'
  | 'start'
  | 'complete'
  | 'abandon'
  | 'reopen'
  | 'resolve'
  | 'link'
  | 'view'

/**
 * Return value of every `todo_tree` call.
 */
export interface TodoTreeResult {
  /** Current full tree state. */
  tree: TreeState
  /** Status summary to help the agent stay oriented. */
  summary: {
    total: number
    counts: Record<NodeStatus, number>
    incomplete: Array<{ id: string; title: string; status: NodeStatus }>
    warning: string | null
  }
}
