/**
 * Reminder rules for the trace tool.
 *
 * Before this module existed, each reminder check re-parsed the full session
 * event history on every pre-step — including JSON-parsing every historical
 * tool call's arguments — and hand-rolled its own latch map. The latch-reset
 * infinite loop came from exactly that arrangement: replaying history and
 * mutating latch state in the same function.
 *
 * Now: {@link buildReminderContext} derives a small context once (step
 * positions from the event log — no argument parsing — and the live tree
 * from the SessionForestStore, which already owns it), and rules are pure
 * functions of that context. {@link ReminderLatch} is the single latch
 * abstraction: a monotonic per-session version with a minimum gap and a
 * fire cap.
 *
 * @module @deepseek-ai/dsh-ops-tool-trace/reminders
 */

import { activeTree } from './types.js'
import type { ForestState, TreeState } from './types.js'
import type { SessionForestStore } from './session-forests.js'
import { TRIGGER_NODE_QUESTION } from './doctrine.js'
import { depthOf } from './tree-layout.js'

/** What a reminder rule sees. Derived once per pre-step, shared by all rules. */
export interface ReminderContext {
  sessionId: string
  /** Latest step position, encoded as turn * 1000 + step. */
  currentStep: number
  /** Step position of the last trace call; 0 = never called. */
  lastTraceStep: number
  /** The live forest (from the store, not a re-fold). */
  forest: ForestState
  /** The active tree — null when no investigation exists. */
  tree: TreeState | null
}

/** Minimal agent shape the context builder reads. */
interface AgentLike {
  session?: {
    id?: string
    events?: Array<{ type: string, data?: { name?: string, turn?: number, step?: number } }>
  }
}

/**
 * Derive the reminder context for one pre-step. Returns null when there is no
 * session event stream to judge from.
 */
export function buildReminderContext(agent: unknown, store: SessionForestStore): ReminderContext | null {
  const session = (agent as AgentLike)?.session
  const events = session?.events
  if (!session?.id || !events || events.length === 0) return null

  let currentStep = 0
  let lastTraceStep = 0
  for (const ev of events) {
    if (ev.type === 'step/start') {
      currentStep = (ev.data?.turn ?? 0) * 1000 + (ev.data?.step ?? 0)
      continue
    }
    // Presence is enough — no argument parsing.
    if (ev.type === 'tool/call' && ev.data?.name === 'trace') lastTraceStep = currentStep
  }

  const forest = store.current({ id: session.id }).forest
  return {
    sessionId: session.id,
    currentStep,
    lastTraceStep,
    forest,
    tree: activeTree(forest),
  }
}

/**
 * One latch abstraction for all reminder rules: fire when `version` has
 * advanced at least `minGap` since the last fire, at most `maxFires` times
 * per session. Because the version is an input (computed from the context,
 * never reset by replaying history), re-evaluating the same state is always
 * idempotent.
 */
export class ReminderLatch {
  private readonly last = new Map<string, { version: number, fires: number }>()

  constructor(
    private readonly minGap: number,
    private readonly maxFires: number,
  ) {}

  shouldFire(sessionId: string, version: number): boolean {
    const prev = this.last.get(sessionId)
    if (prev && (version - prev.version < this.minGap || prev.fires >= this.maxFires)) return false
    this.last.set(sessionId, { version, fires: (prev?.fires ?? 0) + 1 })
    return true
  }
}

/**
 * The idle rule: nudge when an active investigation hasn't updated trace in
 * 5+ steps. Silent when there is no tree or the tree is resolved.
 */
export function createIdleRule(latch: ReminderLatch): (ctx: ReminderContext) => string | null {
  return (ctx) => {
    const tree = ctx.tree
    if (!tree || tree.resolved) return null
    if (ctx.lastTraceStep === 0) return null
    const gap = ctx.currentStep - ctx.lastTraceStep
    if (gap < 5) return null
    if (!latch.shouldFire(ctx.sessionId, ctx.currentStep)) return null
    return `[REMINDER] 过去 ${gap} 步排查没有更新 trace。后续调查动作执行前先 add_step(写下要查什么), 拿到结果立即 complete 带 summary。迷失方向先 view。`
  }
}

/**
 * The nesting rule: fires when steps pile up flat under milestones — no step
 * nested under another step — while completed nodes already carry findings.
 *
 * Kinds are not stored on nodes, so shape is judged by depth: milestone at
 * depth 1, step at depth 2; a step nested under a step lives at depth ≥ 3.
 * "Flat" = at least 3 nodes at depth 2 and nothing deeper.
 */
export function createNestingRule(latch: ReminderLatch): (ctx: ReminderContext) => string | null {
  return (ctx) => {
    const tree = ctx.tree
    if (!tree || tree.resolved) return null
    const nonRoot = tree.nodes.filter((n) => n.parent !== null)
    let flatCount = 0
    let hasDeep = false
    for (const n of nonRoot) {
      const d = depthOf(tree.nodes, n.id)
      if (d === 2) flatCount++
      else if (d >= 3) hasDeep = true
    }
    if (hasDeep || flatCount < 3) return null
    if (!tree.nodes.some((n) => n.summary !== null)) return null
    // Version: tree generation (forest length) × flat-step count — grows when
    // a new tree starts or the flat count grows, so history replay never
    // re-arms the rule.
    const version = ctx.forest.trees.length * 1000 + flatCount
    if (!latch.shouldFire(ctx.sessionId, version)) return null
    return `[REMINDER] 你的 step 全部直接挂在 milestone 下, 但已有 step 带着发现完成。后续 add_step 先问"${TRIGGER_NODE_QUESTION}"——如果答案是某个 step 的发现, parent_id 用那个 step 的 id。`
  }
}
