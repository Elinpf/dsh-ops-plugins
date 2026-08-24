/**
 * SessionForestStore — the single owner of a session's in-process forest.
 *
 * Two state holders exist: this store's map (live, synchronously mutated) and
 * the session projection (durable, rebuilt from the session log). Before this
 * module existed, the reconciliation protocol between them — "map wins during
 * a turn, the projection seeds on first access, the log append precedes
 * execute" — lived in comments inside the tool's execute switch, and every
 * historical state bug came from a caller misapplying that protocol. Now the
 * protocol is code, behind two methods:
 *
 * - {@link current} — read the session's forest, seeding from the projection
 *   on first access. Projection failures are reported loudly once per session
 *   instead of silently starting an empty forest.
 * - {@link apply} — mutate the forest with one trace call. Fully synchronous:
 *   the read → seed → fold → write critical section contains no `await`, so
 *   no concurrent call can interleave. The create_tree double-fold guard
 *   (phantom tree) lives here, not in the caller.
 *
 * @module @deepseek-ai/dsh-ops-tool-trace/session-forests
 */

import type { ForestState, TraceArgs } from './types.js'

/** Minimal event shape the fold consumes. */
export interface FoldableEvent {
  type: string
  data: { name?: string, turn?: number, step?: number, arguments?: string }
}

/** Reads the durable projection state for seeding. Null when absent. */
export type ForestSnapshotter = (session: { id: string }) => ForestState | null

/** Folds one tool/call-shaped event into forest state (the projection fold). */
export type ForestFold = (state: ForestState | null, event: FoldableEvent) => ForestState | null

export class SessionForestStore {
  private readonly forests = new Map<string, ForestState>()
  private readonly seedFailureReported = new Set<string>()

  constructor(
    private readonly snapshot: ForestSnapshotter,
    private readonly fold: ForestFold,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * The current forest for a session. Seeds from the projection on first
   * access (session replay / process restart); afterwards the in-process map
   * is authoritative so parallel calls in one turn see each other immediately.
   */
  current(session: { id: string }): { forest: ForestState, seeded: boolean } {
    const existing = this.forests.get(session.id)
    if (existing) return { forest: existing, seeded: false }

    let seeded: ForestState | null = null
    try {
      seeded = this.snapshot(session)
    } catch (error) {
      // Loud, once per session: silently starting an empty forest would
      // diverge the in-process state from the durable log.
      if (!this.seedFailureReported.has(session.id)) {
        this.seedFailureReported.add(session.id)
        this.warn(`ops-trace: projection seed failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (seeded && seeded.trees.length > 0) {
      this.forests.set(session.id, seeded)
      return { forest: seeded, seeded: true }
    }
    return { forest: { trees: [] }, seeded: false }
  }

  /**
   * Apply one trace call to the session's forest and return the result.
   * Synchronous by design — see the module docstring.
   */
  apply(session: { id: string }, args: TraceArgs, turn: number): ForestState {
    const { forest, seeded } = this.current(session)

    // Phantom-tree guard: the framework appends the tool/call event to the
    // session log — and the projection folds it — BEFORE execute runs. When
    // this very call just seeded the store, the seed already contains this
    // create_tree; folding it again would append a duplicate goal-only tree
    // that later surfaces as the active tree once every real tree resolves.
    if (seeded && args.action === 'create_tree' && args.goal_title) {
      const last = forest.trees[forest.trees.length - 1]
      if (last && !last.resolved && last.nodes.length === 1
          && last.nodes[0].id === 'goal'
          && last.nodes[0].title === args.goal_title
          && last.nodes[0].turns.includes(turn)) {
        return forest
      }
    }

    const event: FoldableEvent = {
      type: 'tool/call',
      data: { name: 'trace', turn, arguments: JSON.stringify(args) },
    }
    const updated = this.fold(forest, event) ?? forest
    if (updated.trees.length === 0) this.forests.delete(session.id)
    else this.forests.set(session.id, updated)
    return updated
  }

  /** Drop all in-process state (fiber disposal). */
  clear(): void {
    this.forests.clear()
    this.seedFailureReported.clear()
  }
}
