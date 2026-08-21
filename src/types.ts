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
  /** Auto-generated unique id (e.g. 'root', 'n1', 'n2'). */
  id: string
  /** One-line description of this node. */
  title: string
  /** Current status per the 05 state machine. */
  status: NodeStatus
  /** Parent node id; `null` for the root node. */
  parent: string | null
  /** Turns that operated on this node. */
  turns: number[]
  /** Expanded detail text (written by the `note` action). */
  detail: string | null
  /** Resolution summary (only on `resolved` nodes, written by `resolve`). */
  summary: string | null
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

/**
 * Session event map extension for the ops-todo-tree plugin.
 *
 * Each event carries the turn number and only the data needed for that action.
 * The projection folds these incrementally into a {@link TreeState}.
 */
export interface TodoTreeEventMap {
  /** Create the tree: root problem + final goal. */
  'todo_tree/create': {
    turn: number
    root_id: string
    root_title: string
    goal_id: string
    goal_title: string
  }
  /** Add a node (step or milestone) as a child of an existing node. */
  'todo_tree/add': {
    turn: number
    node_id: string
    parent_id: string
    title: string
    /** 'step' → initial status `pending`; 'milestone' → initial status `goal`. */
    kind: 'step' | 'milestone'
    /** `true` → branch to a new lane; `false` → inherit parent's lane. */
    branch: boolean
  }
  /** Start working on a node: → `in_progress`. */
  'todo_tree/start': {
    turn: number
    node_id: string
  }
  /** Complete a node: → `done`. */
  'todo_tree/complete': {
    turn: number
    node_id: string
  }
  /** Abandon a node (dead end): → `dead_end`. */
  'todo_tree/abandon': {
    turn: number
    node_id: string
  }
  /** Resolve the final goal: → `resolved`, with a summary. */
  'todo_tree/resolve': {
    turn: number
    goal_id: string
    summary: string
  }
  /** Add detail text to a node (no status change). */
  'todo_tree/note': {
    turn: number
    node_id: string
    detail: string
  }
}

// ── Tool action types ────────────────────────────────────────────────────────

/** The 9 actions the `todo_tree` tool accepts. */
export type TodoTreeAction =
  | 'create_tree'
  | 'add_step'
  | 'add_milestone'
  | 'start'
  | 'complete'
  | 'abandon'
  | 'resolve'
  | 'note'
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
