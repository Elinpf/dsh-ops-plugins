/**
 * Type definitions for the ops-trace plugin.
 *
 * @module @deepseek-ai/dsh-ops-tool-trace
 */

// ── Node status (05 state machine) ──────────────────────────────────────────

/**
 * The six node statuses from the state machine — the single source of truth
 * for the status set. The zod projection schema, the tool's output JSON
 * schema, and the status_filter enum all derive from this list.
 *
 * - `goal` — a stable target (milestone or final goal); uses dashed connectors
 * - `pending` — a step not yet started; uses thin dashed connectors
 * - `in_progress` — actively being worked on
 * - `done` — completed
 * - `dead_end` — proven unviable; NOT a terminal state (can re-explore)
 * - `resolved` — final goal achieved; terminal state
 */
export const NODE_STATUSES = ['goal', 'pending', 'in_progress', 'done', 'dead_end', 'resolved'] as const

export type NodeStatus = typeof NODE_STATUSES[number]

// ── Tree node (projection state) ─────────────────────────────────────────────

/**
 * A single node in the investigation tree.
 * Lane and depth are NOT stored here — they are derived client-side.
 */
export interface TreeNode {
  /** Unique id within the tree. The root node has id 'goal'. */
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
  /** Creation-time rationale (add_step/add_milestone): the hypothesis's
   *  "because" clause or the step's concrete target. */
  detail: string | null
  /** Causal edges: other node ids that are the root cause of this node. */
  caused_by: string[]
}

/**
 * One investigation tree (goal + its milestones and steps).
 */
export interface TreeState {
  /** All nodes in this tree. */
  nodes: TreeNode[]
  /** Whether this tree's goal has been resolved. */
  resolved: boolean
}

/**
 * The full session state carried in a projection snapshot.
 * A forest of independent investigation trees — resolved trees are kept
 * for reference; the active tree is the latest unresolved one.
 */
export interface ForestState {
  /** All trees in chronological order. */
  trees: TreeState[]
}

/**
 * The active tree is the last unresolved one, or the last tree if all are resolved.
 */
export function activeTree(forest: ForestState): TreeState | null {
  for (let i = forest.trees.length - 1; i >= 0; i--) {
    if (!forest.trees[i].resolved) return forest.trees[i]
  }
  return forest.trees.length > 0 ? forest.trees[forest.trees.length - 1] : null
}

// ── Session events (incremental, append-only) ────────────────────────────────

// ── Tool action types ────────────────────────────────────────────────────────

/** The 11 actions the `trace` tool accepts. */
export type TraceAction =
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
  | 'help'

/**
 * Return value of every `trace` call.
 * `tree` is the active tree that was operated on (or the resolved one).
 */
export interface TraceResult {
  /** The active tree that was operated on. */
  tree: TreeState
  /** Status summary of the active tree. */
  summary: {
    total: number
    counts: Record<NodeStatus, number>
    incomplete: Array<{ id: string; title: string; status: NodeStatus }>
    warning: string | null
  }
  /** ID of the newly created node (add_step/add_milestone only). */
  new_node?: string
  /** Non-blocking advisory hint (add_step only): the chosen parent looks
   *  like a flat-hang mistake. Never a rejection — see doctrine.ts. */
  hint?: string
}

/**
 * A single causal-edge pair used by the `link` action.
 */
export interface LinkPair {
  id: string
  caused_by: string
}

/**
 * Tool arguments for `trace`. All fields are optional except `action`;
 * which fields are required depends on the action (enforced at execute time).
 */
export interface TraceArgs {
  action: TraceAction
  goal_title?: string
  id?: string
  parent_id?: string
  title?: string
  ids?: string[]
  summary?: string
  detail?: string
  caused_by?: string
  links?: LinkPair[]
  status_filter?: NodeStatus
  /** view output format: 'full' (default, with detail/summary) or 'tree'
   *  (indented outline, shape only). */
  format?: 'full' | 'tree'
}
