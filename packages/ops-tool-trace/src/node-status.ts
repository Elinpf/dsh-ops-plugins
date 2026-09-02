/**
 * Runtime home of the node-status vocabulary (moved out of types.ts, which is
 * types-only). The zod projection schema, the tool's output JSON schema, and
 * the status_filter enum all derive from NODE_STATUSES — one source of truth.
 *
 * @module @elinpf/dsh-ops-tool-trace
 */

import type { ForestState, TreeState } from './types.js'

/**
 * The six node statuses from the state machine — the single source of truth
 * for the status set.
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

/**
 * The active tree is the last unresolved one, or the last tree if all are resolved.
 */
export function activeTree(forest: ForestState): TreeState | null {
  for (let i = forest.trees.length - 1; i >= 0; i--) {
    if (!forest.trees[i].resolved) return forest.trees[i]
  }
  return forest.trees.length > 0 ? forest.trees[forest.trees.length - 1] : null
}
