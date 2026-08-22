/**
 * Ops-trace: an investigation tree tool that replaces `todo_write` in the ops preset.
 *
 * Agent-driven, append-only event log, tree + unique resolved convergence terminal.
 * See `.scratch/ops-trace/research/` for the full design.
 *
 * @module @deepseek-ai/dsh-ops-trace
 */

import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

// ── Types (import type so they erase at runtime) ─────────────────────────────

import type { Context } from '@deepseek-ai/cordis'
import type { OpsPromptsHandle } from '@deepseek-ai/dsh-ops-prompts'

// ── Module augmentation: declare the opsPrompts service on Context ──────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsPrompts?: OpsPromptsHandle
    sessionProjections?: {
      register(def: {
        key: string
        schema: unknown
        init: () => ForestState | null
        apply: (state: ForestState | null, event: FoldEvent) => ForestState | null
        view: (state: ForestState | null) => ForestState | null
        stateVersion: number
      }): () => void
      snapshot(session: { id: string }): { values: { trace?: ForestState | null } }
    }
  }
}

import type {
  NodeStatus,
  TreeState,
  TreeNode,
  ForestState,
  TraceAction,
  TraceResult,
  TraceArgs,
  LinkPair,
} from './types.ts'

/** The active tree is the last unresolved one, or the last tree if all resolved. */
function activeTree(forest: ForestState | null): TreeState | null {
  if (!forest || forest.trees.length === 0) return null
  for (let i = forest.trees.length - 1; i >= 0; i--) {
    if (!forest.trees[i].resolved) return forest.trees[i]
  }
  return forest.trees[forest.trees.length - 1]
}

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-trace'
const inject = ['tools']

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Schemastery configuration for the ops-trace tool consumer.
 */
const Config = z.object({})

// ── State machine (05) ───────────────────────────────────────────────────────

/** Legal status transitions. Key = from-status, value = set of allowed to-statuses. */
const TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  goal: ['in_progress', 'done', 'resolved'],
  pending: ['in_progress', 'done', 'dead_end'],
  in_progress: ['done', 'dead_end'],
  done: ['in_progress', 'dead_end', 'done'],
  dead_end: ['in_progress'],
  resolved: [],
}

/** Check whether a transition is legal per the 05 state machine. */
function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

// ── Node id generation ───────────────────────────────────────────────────────

let nodeCounter = 0
function generateId(): string {
  nodeCounter++
  return 'n' + nodeCounter
}

/** Generate a slug from a title.
 *  - ASCII alphanumerics are kept and lowercased.
 *  - Non-ASCII characters (Chinese, Japanese, etc.) are kept as-is.
 *  - Whitespace and punctuation become hyphens.
 *  e.g. "Check Ceph" → "check-ceph", "检查存储" → "检查存储",
 *       "baizeops 故障" → "baizeops-故障"
 *  If the slug already exists in the tree, append a numeric suffix. */
function slugify(title: string, existingIds: Set<string>): string {
  let slug = title
    .toLowerCase()
    .replace(/[\s_]+/g, '-')       // whitespace → -
    .replace(/[^\p{L}\p{N}-]+/gu, '', ) // remove punctuation, keep letters/numbers/hyphens (unicode-aware)
    .replace(/-{2,}/g, '-')        // collapse multiple hyphens
    .replace(/^-+|-+$/g, '')      // trim leading/trailing hyphens
    .slice(0, 40)
  if (!slug) slug = 'node'
  // Ensure uniqueness
  let result = slug
  let suffix = 2
  while (existingIds.has(result)) {
    result = `${slug}-${suffix++}`
  }
  return result
}

// ── Turn extraction (02) ─────────────────────────────────────────────────────

/** Extract the current turn number from the agent's session events. */
function currentTurn(exec: ToolRunContext): number {
  const events = exec.agent?.session?.events
  if (!events) return 0
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type: string, data?: { turn?: number } }
    if (ev.type === 'turn/start') return ev.data?.turn ?? 0
  }
  return 0
}

// ── Projection fold (09) ─────────────────────────────────────────────────────

/**
 * Fold one tool/call event into tree state (pure function, allocation-fresh).
 * The projection reads tool/call events where name === 'trace' and
 * parses the arguments JSON to reconstruct the tree.
 * No custom session event types are needed — tool/call is a known type.
 */
/** Minimal event shape that foldEvent reads from the session log. */
interface FoldEvent {
  type: string
  data: {
    name?: string
    turn?: number
    step?: number
    arguments?: string
  }
}

function foldEvent(state: ForestState | null, event: FoldEvent): ForestState | null {
  // Only fold tool/call events for the trace tool
  if (event.type !== 'tool/call') return state
  const data = event.data
  if (data?.name !== 'trace') return state

  // Parse arguments JSON string
  let args: TraceArgs
  try {
    args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
  } catch {
    return state
  }

  const turn = data.turn ?? data.step ?? 0
  const action = args.action
  const trees = state?.trees ? [...state.trees] : []

  switch (action) {
    case 'create_tree': {
      // Skip if goal_title missing (failed tool call that was logged before validation)
      if (!args.goal_title) return state
      const newTree: TreeState = {
        nodes: [{
          id: 'goal', title: args.goal_title, status: 'goal',
          parent: null, turns: [turn], summary: null, caused_by: [],
        }],
        resolved: false,
      }
      return { trees: [...trees, newTree] }
    }

    case 'add_step':
    case 'add_milestone': {
      // Skip if required fields missing (failed tool call logged before validation)
      if (!args.id || !args.parent_id || !args.title) return state
      const forest = state ?? { trees: [] }
      const tree = activeTree(forest)
      if (!tree) return state
      // Skip if node id already exists (duplicate of a successful call)
      if (tree.nodes.some(n => n.id === args.id)) return state
      // Skip if parent doesn't exist
      if (!tree.nodes.some(n => n.id === args.parent_id)) return state
      const kind = action === 'add_milestone' ? 'milestone' : 'step'
      const updatedTree: TreeState = {
        ...tree,
        nodes: [...tree.nodes, {
          id: args.id, title: args.title,
          status: kind === 'milestone' ? 'goal' : 'pending',
          parent: args.parent_id, turns: [turn], summary: null, caused_by: [],
        }],
      }
      return replaceTree(forest, tree, updatedTree)
    }

    case 'start':
    case 'complete':
    case 'abandon':
    case 'reopen': {
      const forest = state ?? { trees: [] }
      const tree = activeTree(forest)
      if (!tree) return state
      const newStatus: NodeStatus =
        action === 'start' || action === 'reopen' ? 'in_progress'
        : action === 'complete' ? 'done'
        : 'dead_end'
      const nodeIds: string[] = Array.isArray(args.ids) ? args.ids : (args.id ? [args.id] : [])
      if (nodeIds.length === 0) return state
      let updatedTree = tree
      for (const nid of nodeIds) {
        updatedTree = updateNodeInTree(updatedTree, nid, turn, (n) => {
          n.status = newStatus
          if (action === 'complete' && args.summary) n.summary = args.summary
        }) ?? updatedTree
      }
      return replaceTree(forest, tree, updatedTree)
    }

    case 'resolve': {
      if (!args.summary) return state
      const forest = state ?? { trees: [] }
      const tree = activeTree(forest)
      if (!tree) return state
      const updatedTree = updateNodeInTree(tree, 'goal', turn, (n) => {
        n.status = 'resolved'
        n.summary = args.summary ?? null
      })
      if (!updatedTree) return state
      const resolvedTree: TreeState = { ...updatedTree, resolved: true }
      return replaceTree(forest, tree, resolvedTree)
    }

    case 'link': {
      const forest = state ?? { trees: [] }
      const tree = activeTree(forest)
      if (!tree) return state
      const links: LinkPair[] = Array.isArray(args.links) ? args.links : (args.id && args.caused_by ? [{id: args.id, caused_by: args.caused_by}] : [])
      if (links.length === 0) return state
      // Validate all links have required fields and nodes exist
      const validLinks = links.filter(link => link.id && link.caused_by
        && tree.nodes.some(n => n.id === link.id)
        && tree.nodes.some(n => n.id === link.caused_by))
      if (validLinks.length === 0) return state
      let updatedTree = tree
      for (const link of validLinks) {
        updatedTree = updateNodeInTree(updatedTree, link.id, turn, (n) => {
          if (!n.caused_by.includes(link.caused_by)) {
            n.caused_by = [...n.caused_by, link.caused_by]
          }
        }) ?? updatedTree
      }
      return replaceTree(forest, tree, updatedTree)
    }

    default:
      return state
  }
}

/** Replace one tree in the forest (by reference identity). */
function replaceTree(forest: ForestState, old: TreeState, updated: TreeState): ForestState {
  return { trees: forest.trees.map(t => t === old ? updated : t) }
}

/** Pure helper: copy nodes, find target, create new copy without mutating the original. */
function updateNodeInTree(
  tree: TreeState,
  nodeId: string,
  turn: number,
  mutate: (n: TreeNode) => void,
): TreeState | null {
  let found = false
  const nodes = tree.nodes.map((n) => {
    if (n.id !== nodeId) return n
    found = true
    const copy: TreeNode = { ...n, turns: n.turns.includes(turn) ? n.turns : [...n.turns, turn] }
    mutate(copy)
    return copy
  })
  return found ? { ...tree, nodes } : null
}

// ── Summary builder (06: advisor, not gatekeeper) ───────────────────────────

const ALL_STATUSES: NodeStatus[] = ['goal', 'pending', 'in_progress', 'done', 'dead_end', 'resolved']

function buildSummary(tree: TreeState | null): TraceResult['summary'] {
  const nodes = tree?.nodes ?? []
  const counts: Record<NodeStatus, number> = {
    goal: 0, pending: 0, in_progress: 0, done: 0, dead_end: 0, resolved: 0,
  }
  for (const n of nodes) counts[n.status]++
  // Incomplete = not done, not dead_end, not resolved, and not the goal node.
  // The goal node is structural, not "incomplete".
  const incomplete = nodes
    .filter((n) => n.parent !== null && n.status !== 'done' && n.status !== 'dead_end' && n.status !== 'resolved')
    .map((n) => ({ id: n.id, title: n.title, status: n.status }))
  const warning = incomplete.length > 0 && tree?.resolved
    ? `${incomplete.length} node(s) still incomplete`
    : null
  return { total: nodes.length, counts, incomplete, warning }
}

// ── Tool description ─────────────────────────────────────────────────────────

const TOOL_DESCRIPTION = [
  '维护事件排查的调查树。结构: goal → milestone(待验证假设) → step(探索动作, 可嵌套于 milestone 或其他 step 之下)。发现新问题时, 在当前节点下嵌套子节点。 ',
  'Actions: create_tree, add_milestone, add_step, start, complete, abandon, reopen, resolve, link, view。',
].join('')

// ── Projection schema (validates the view for client transport) ─────────────

const treeNodeSchema = zod.object({
  id: zod.string(),
  title: zod.string(),
  status: zod.enum(['goal', 'pending', 'in_progress', 'done', 'dead_end', 'resolved']),
  parent: zod.string().nullable(),
  turns: zod.array(zod.number()),
  summary: zod.string().nullable(),
  caused_by: zod.array(zod.string()),
})

const treeStateSchema = zod.object({
  nodes: zod.array(treeNodeSchema),
  resolved: zod.boolean(),
})

const forestStateSchema = zod.object({
  trees: zod.array(treeStateSchema),
})

const traceProjectionSchema = zod.union([forestStateSchema, zod.null()])

// ── Tree renderers (model-visible output) ────────────────────────────────────

/** Status → emoji for compact rendering. */
const STATUS_LABEL: Record<string, string> = {
  pending: 'pending',
  in_progress: 'in_progress',
  done: 'done',
  dead_end: 'dead_end',
  goal: '',
  resolved: 'resolved',
}

/** Sort children: in_progress first, then pending, done, dead_end; goal always last. */
const STATUS_ORDER: Record<string, number> = {
  in_progress: 0, pending: 1, done: 2, dead_end: 3, goal: 4, resolved: 5,
}

function sortChildren(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    // goal node always last (it's the convergence terminal)
    const aIsGoal = a.id === 'goal'
    const bIsGoal = b.id === 'goal'
    if (aIsGoal && !bIsGoal) return 1
    if (!aIsGoal && bIsGoal) return -1
    return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
  })
}

/** Build child map and find root from a flat node list. */
function buildTreeIndex(nodes: TreeNode[]) {
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
 * Compact render: tree characters, one line per node, id + status + title.
 * No detail/summary/turns. New node marked with *.
 */
function renderCompact(value: TraceResult, newNodeId?: string): string {
  if (!value || !value.tree || !value.tree.nodes || value.tree.nodes.length === 0) {
    return 'No tree — call create_tree first.'
  }

  const tree: TreeState = value.tree
  const summary = value.summary
  const { children, root } = buildTreeIndex(tree.nodes)
  const lines: string[] = []

  // Summary line
  if (summary) {
    const parts: string[] = []
    const c = summary.counts || {}
    if (c.done) parts.push(`${c.done} done`)
    if (c.in_progress) parts.push(`${c.in_progress} in_progress`)
    if (c.pending) parts.push(`${c.pending} pending`)
    if (c.dead_end) parts.push(`${c.dead_end} dead_end`)
    if (tree.resolved) parts.push('resolved')
    if (summary.warning) parts.push('WARN: ' + summary.warning)
    if (parts.length > 0) {
      lines.push(parts.join(' | '))
      lines.push('')
    }
  }

  function renderNode(node: TreeNode, prefix: string, isLast: boolean): void {
    const label = STATUS_LABEL[node.status] || ''
    const isNew = node.id === newNodeId ? '*' : ''
    const labelStr = label ? `${label} ` : ''
    const connector = isLast ? '└── ' : '├── '
    lines.push(`${prefix}${connector}${isNew}${node.id}: ${labelStr}${node.title}`)

    const kids = sortChildren(children[node.id] || [])
    const childPrefix = prefix + (isLast ? '    ' : '│   ')
    for (let i = 0; i < kids.length; i++) {
      renderNode(kids[i], childPrefix, i === kids.length - 1)
    }
  }

  if (root) renderNode(root, '', true)

  return lines.join('\n')
}

/**
 * Full render: includes detail, summary, and turns for each node.
 * Used by the `view` action.
 */
function renderFull(value: TraceResult): string {
  if (!value || !value.tree || !value.tree.nodes || value.tree.nodes.length === 0) {
    return 'No tree — call create_tree first.'
  }

  const tree: TreeState = value.tree
  const { children, root } = buildTreeIndex(tree.nodes)
  const lines: string[] = []

  function renderNode(node: TreeNode, prefix: string, isLast: boolean): void {
    const label = STATUS_LABEL[node.status] || ''
    const labelStr = label ? `${label} ` : ''
    const connector = isLast ? '└── ' : '├── '
    const turnStr = node.turns?.length ? ` (turn ${node.turns.join(',')})` : ''
    let line = `${prefix}${connector}${node.id}: ${labelStr}${node.title}${turnStr}`
    // Inline caused_by
    if (node.caused_by.length > 0) {
      line += `  ← caused_by: ${node.caused_by.join(', ')}`
    }
    // Inline summary
    if (node.summary) {
      line += `  summary: ${node.summary}`
    }
    lines.push(line)

    const indent = prefix + (isLast ? '    ' : '│   ')
    const kids = sortChildren(children[node.id] || [])
    for (let i = 0; i < kids.length; i++) {
      renderNode(kids[i], indent, i === kids.length - 1)
    }
  }

  if (root) renderNode(root, '', true)
  if (tree.resolved) lines.push('resolved')

  return lines.join('\n')
}

/**
 * Render a single line of statistics.
 */
function renderStats(value: TraceResult): string {
  if (!value || !value.summary) return ''
  const summary = value.summary
  const parts: string[] = []
  parts.push(`${summary.total || 0} nodes`)
  const c = summary.counts || {}
  if (c.done) parts.push(`${c.done} done`)
  if (c.in_progress) parts.push(`${c.in_progress} in_progress`)
  if (c.pending) parts.push(`${c.pending} pending`)
  if (c.dead_end) parts.push(`${c.dead_end} dead_end`)
  if (value.tree?.resolved) parts.push('resolved')
  return parts.join(' | ')
}

/**
 * Render a single node line (inline caused_by + summary).
 */
function renderNodeLine(node: TreeNode, marker: string): string {
  const label = STATUS_LABEL[node.status] || ''
  const labelStr = label ? `${label} ` : ''
  let line = `${marker} ${node.id}: ${labelStr}${node.title}`
  if (node.caused_by.length > 0) {
    line += `  ← caused_by: ${node.caused_by.join(', ')}`
  }
  if (node.summary) {
    line += `  summary: ${node.summary}`
  }
  return line
}

/**
 * Decide what to render based on the action.
 * - view: full tree with all details
 * - create_tree: full compact tree (tree is tiny — just goal node)
 * - add_step/add_milestone: increment — new node + parent + stats
 * - start/complete/abandon/reopen: increment — changed node + stats
 * - link: increment — changed node (with new caused_by) + stats
 * - resolve: increment — goal node (resolved) + stats
 */
function renderOutput(args: TraceArgs, value: TraceResult): string {
  const action = args?.action

  // view: always full tree
  if (action === 'view') return renderFull(value)

  // create_tree: tree is just 1 node, return it
  if (action === 'create_tree') {
    return renderCompact(value, undefined)
  }

  // Incremental output for all other actions
  if (!value || !value.tree) return 'No tree — call create_tree first.'

  const tree: TreeState = value.tree
  const stats = renderStats(value)
  const lines: string[] = []

  if (action === 'add_step' || action === 'add_milestone') {
    // Show new node + parent
    const newId = value.new_node
    if (newId) {
      const node = tree.nodes.find((n) => n.id === newId)
      if (node) {
        lines.push(renderNodeLine(node, '+'))
        if (node.parent) {
          lines.push(`  parent: ${node.parent}`)
        }
      }
    }
  } else if (action === 'start' || action === 'complete' || action === 'abandon' || action === 'reopen') {
    // Show changed node id + new status only (no summary for brevity)
    const ids: string[] = Array.isArray(args.ids) ? args.ids : (args.id ? [args.id] : [])
    for (const nid of ids) {
      const node = tree.nodes.find((n) => n.id === nid)
      if (node) {
        const label = STATUS_LABEL[node.status] || ''
        lines.push(`= ${nid}: ${label}`)
      }
    }
  } else if (action === 'link') {
    // Show changed nodes with their new caused_by (id + caused_by only)
    const links: LinkPair[] = Array.isArray(args.links) ? args.links : [{id: args.id!, caused_by: args.caused_by!}]
    for (const link of links) {
      lines.push(`~ ${link.id} ← caused_by: ${link.caused_by}`)
    }
  } else if (action === 'resolve') {
    // Show resolved goal
    lines.push('= goal: resolved')
  }

  if (stats) lines.push(stats)
  return lines.join('\n')
}

// ── Tool implementation ─────────────────────────────────────────────────────

/**
 * In-process tree state keyed by session id.
 * 
 * The projection (sessionProjections) provides persistence and replay from the
 * session log (tool/call events). But when the model makes PARALLEL tool calls
 * in one message (e.g. 3 × add_milestone), each call reads the same projection
 * snapshot — they don't see each other's mutations. This map is the live,
 * synchronously-mutated source of truth during a turn, so parallel calls see
 * each other immediately.
 * 
 * The projection catches up later when DSH framework appends the tool/call
 * events to the session log. On session start / replay, the projection's
 * snapshot seeds this map.
 */
const sessionForests = new Map<string, ForestState>()

function getSessionForest(sessionId: string): ForestState | null {
  return sessionForests.get(sessionId) ?? null
}

function setSessionForest(sessionId: string, forest: ForestState | null): void {
  if (forest === null || forest.trees.length === 0) sessionForests.delete(sessionId)
  else sessionForests.set(sessionId, forest)
}

/** Minimal projection-registry interface used by this plugin. */
interface ProjectionRegistryLike {
  snapshot(session: { id: string }): { values: { trace?: ForestState | null } }
}

function apply(ctx: Context, _config: Record<string, never>): void {
  // ── Register session projection (09) ──────────────────────────────────────
  // Store the registry reference so the tool's execute can read the current
  // projection state via snapshot(session) — the host-side API (not faceOf,
  // which is client-only).
  let projectionRegistry: ProjectionRegistryLike | null = null
  ctx.inject(['sessionProjections'], (pctx: Context) => {
    projectionRegistry = pctx.sessionProjections ?? null
    pctx.sessionProjections!.register({
      key: 'trace',
      schema: traceProjectionSchema,
      init: () => null,
      apply: foldEvent,
      view: (s: ForestState | null) => s,
      stateVersion: 2,
    })
  })

  // Clean up in-process tree state when the plugin's fiber is disposed
  // (process restart, preset unmount). session/disposed is a Session-scoped
  // event we can't hear from the plugin's global ctx; instead, the execute
  // function falls back to the projection snapshot for session replay, so
  // stale entries in the map are harmless — they're overwritten on first
  // call and never cause cross-session contamination because the key is
  // the sessionId.
  ctx.effect(() => () => { sessionForests.clear() })

  // ── Register model tool (06) ──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trace',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: [
        'create_tree', 'add_step', 'add_milestone',
        'start', 'complete', 'abandon', 'reopen', 'resolve', 'link', 'view',
      ], description: 'The action to perform.' },

      goal_title: { type: 'string', description: 'Title for the investigation goal (create_tree only).' },

      id: { type: 'string', description: 'Node id. For add_step/add_milestone: the new node\'s semantic id (e.g. "ceph-full"). For start/complete/abandon/reopen: single target node. For link: target node (use with caused_by).' },
      parent_id: { type: 'string', description: 'Parent node id (add_step/add_milestone only). Use "goal" for top-level milestones.' },
      title: { type: 'string', description: 'Node title (add_step/add_milestone only).' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of node ids for batch mode (start/complete/abandon/reopen).',
      },

      summary: { type: 'string', description: 'How the goal/node was resolved. Required for resolve. Optional for complete — records what was found/fixed.' },

      caused_by: { type: 'string', description: 'Node id that is the root cause (link only). Expresses: "id is caused by caused_by".' },
      links: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            caused_by: { type: 'string', required: true },
          },
        },
        description: 'Batch link: array of {id, caused_by} pairs (link only).',
      },

      status_filter: { type: 'string', enum: ['pending', 'in_progress', 'done', 'dead_end', 'resolved'], description: 'Filter view to nodes of one status (view only, optional).' },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tree: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              nodes: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: ['goal', 'pending', 'in_progress', 'done', 'dead_end', 'resolved'] },
                    parent: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                    turns: { type: 'array', required: true, items: { type: 'number' } },
                    summary: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                    caused_by: { type: 'array', required: true, items: { type: 'string' } },
                  },
                },
              },
              resolved: { type: 'boolean', required: true },
            },
          },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              total: { type: 'integer', required: true },
              counts: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  goal: { type: 'integer', required: true },
                  pending: { type: 'integer', required: true },
                  in_progress: { type: 'integer', required: true },
                  done: { type: 'integer', required: true },
                  dead_end: { type: 'integer', required: true },
                  resolved: { type: 'integer', required: true },
                },
              },
              incomplete: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: ['goal', 'pending', 'in_progress', 'done', 'dead_end', 'resolved'] },
                  },
                },
              },
              warning: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          new_node: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: renderOutput(args, value),
      }],
    },

    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('trace requires an owning agent session')
      const turn = currentTurn(exec)
      const sessionId = agent.session?.id ?? agent.id ?? 'default'

      // Read current forest: prefer the in-process state (handles parallel calls
      // within the same turn); fall back to the projection snapshot (handles
      // session replay / first call after restart).
      let forest: ForestState = getSessionForest(sessionId) ?? { trees: [] }
      if (forest.trees.length === 0 && projectionRegistry) {
        try {
          const snap = projectionRegistry.snapshot(agent.session)
          const projForest = snap?.values?.trace ?? null
          if (projForest && projForest.trees.length > 0) {
            forest = projForest
            setSessionForest(sessionId, forest)
          }
        } catch {
          // projection not available yet
        }
      }

      // The active tree is the last unresolved one, or the last tree if all resolved
      let tree = activeTree(forest)

      switch (args.action as TraceAction) {
        case 'create_tree': {
          if (!args.goal_title) throw new Error('trace: goal_title is required for create_tree')
          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(forest, ev)
          setSessionForest(sessionId, updated)
          const newTree = updated!.trees[updated!.trees.length - 1]
          const result: TraceResult = { tree: newTree, summary: buildSummary(newTree) }
          return result
        }

        case 'add_step':
        case 'add_milestone': {
          if (!tree) throw new Error('trace: no tree — call create_tree first')
          if (!args.parent_id) throw new Error('trace: parent_id is required')
          if (!args.title) throw new Error('trace: title is required')
          if (!args.id) throw new Error('trace: id is required')
          const parent = tree.nodes.find((n) => n.id === args.parent_id)
          if (!parent) throw new Error(`trace: parent node "${args.parent_id}" not found`)
          if (tree.nodes.some((n) => n.id === args.id)) {
            throw new Error(`trace: node id "${args.id}" already exists`)
          }

          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(forest, ev)
          setSessionForest(sessionId, updated)
          const updatedTree = activeTree(updated!)!
          const result: TraceResult = { tree: updatedTree, summary: buildSummary(updatedTree) }
          result.new_node = args.id
          return result
        }

        case 'start':
        case 'complete':
        case 'abandon':
        case 'reopen': {
          if (!tree) throw new Error('trace: no tree')
          const nodeIds: string[] = Array.isArray(args.ids) ? args.ids : (args.id ? [args.id] : [])
          if (nodeIds.length === 0) throw new Error('trace: id (or ids array) is required')
          const targetStatus: NodeStatus =
            args.action === 'start' || args.action === 'reopen' ? 'in_progress'
            : args.action === 'complete' ? 'done'
            : 'dead_end'

          // Validate transitions — idempotent if already at target status
          for (const nid of nodeIds) {
            const node = tree.nodes.find((n) => n.id === nid)
            if (!node) throw new Error(`trace: node "${nid}" not found`)
            if (node.status === targetStatus) continue // idempotent — already at target
            if (!canTransition(node.status, targetStatus)) {
              throw new Error(`trace: cannot transition "${nid}" from "${node.status}" to "${targetStatus}"`)
            }
          }

          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(forest, ev)
          setSessionForest(sessionId, updated)
          const updatedTree = activeTree(updated!)!
          const result: TraceResult = { tree: updatedTree, summary: buildSummary(updatedTree) }
          return result
        }

        case 'resolve': {
          if (!tree) throw new Error('trace: no tree')
          if (!args.summary) throw new Error('trace: summary is required for resolve')
          const goal = tree.nodes.find((n) => n.id === 'goal')
          if (!goal) throw new Error('trace: no goal node to resolve')
          if (goal.status === 'resolved') {
            return { tree: tree!, summary: buildSummary(tree!) }
          }
          if (!canTransition(goal.status, 'resolved')) {
            throw new Error(`trace: goal is "${goal.status}", cannot resolve`)
          }
          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(forest, ev)
          setSessionForest(sessionId, updated)
          const updatedTree = updated!.trees[updated!.trees.length - 1]
          const result: TraceResult = { tree: updatedTree, summary: buildSummary(updatedTree) }
          return result
        }

        case 'link': {
          if (!tree) throw new Error('trace: no tree')
          const links: LinkPair[] = Array.isArray(args.links) ? args.links : [{id: args.id!, caused_by: args.caused_by!}]
          if (links.length === 0) throw new Error('trace: at least one link is required')

          // Validate all nodes exist
          for (const link of links) {
            if (!link.id) throw new Error('trace: id is required for link')
            if (!link.caused_by) throw new Error('trace: caused_by is required for link')
            const node = tree.nodes.find((n) => n.id === link.id)
            if (!node) throw new Error(`trace: node "${link.id}" not found`)
            const target = tree.nodes.find((n) => n.id === link.caused_by)
            if (!target) throw new Error(`trace: node "${link.caused_by}" not found`)
          }

          // Check if all links already exist (idempotent)
          const allExist = links.every(link => {
            const node = tree!.nodes.find((n) => n.id === link.id)
            return node && node.caused_by.includes(link.caused_by)
          })
          if (allExist) {
            return { tree: tree!, summary: buildSummary(tree!) }
          }

          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(forest, ev)
          setSessionForest(sessionId, updated)
          const updatedTree = activeTree(updated!)!
          const result: TraceResult = { tree: updatedTree, summary: buildSummary(updatedTree) }
          return result
        }

        case 'view': {
          if (!tree) throw new Error('trace: no tree — call create_tree first')
          if (args.status_filter) {
            const filtered: TreeState = {
              resolved: tree.resolved,
              nodes: tree.nodes.filter((n) =>
                n.parent === null || n.id === 'goal' || n.status === args.status_filter
              ),
            }
            return { tree: filtered, summary: buildSummary(tree!) }
          }
          return { tree: tree!, summary: buildSummary(tree!) }
        }

        default:
          throw new Error(`trace: unknown action "${args.action}"`)
      }
      // Unreachable — all cases return directly
      throw new Error('trace: unreachable')
    },

    presentCall: (args) => {
      const action: string = args.action
      const title = action === 'create_tree' ? 'Create investigation tree'
        : action === 'add_step' ? 'Add step'
        : action === 'add_milestone' ? 'Add milestone'
        : action === 'resolve' ? 'Resolve'
        : action.charAt(0).toUpperCase() + action.slice(1)
      return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
    },
  }))

  // ── System prompt section ──────────────────────────────────────────────────
  // Static documentation (always present)
  const staticText = [
    '## trace — 调查树',
    '',
    '用 `trace` 维护事件排查的调查树。死路保留可见, 分支展示并行路径。',
    '',
    '### Actions',
    '- `create_tree` — 创建新的调查树。开始排查或解决上一棵树后调用。需要 `goal_title`。',
    '- `add_milestone` — 添加待验证假设。milestone 是一个可验证的判断("我怀疑存储满了""我怀疑 DNS 异常")。需要 `id`, `parent_id`, `title`。',
    '- `add_step` — 添加探索动作。step 是验证假设的具体动作("查 OSD 使用率""读 rbdplugin 日志")。可挂载于 milestone 或其他 step 下。需要 `id`, `parent_id`, `title`。',
    '- `start` — 标记为进行中。传 `id` 或 `ids` 数组。',
    '- `complete` — 标记为完成(可跳过 start)。可选 `summary` 记录发现。传 `id` 或 `ids` 数组。',
    '- `abandon` — 标记为死路或已不相关。传 `id` 或 `ids` 数组。',
    '- `reopen` — 将已完成或死路节点重新激活为进行中。传 `id` 或 `ids` 数组。',
    '- `resolve` — 标记 goal 已解决。需要 `summary`。',
    '- `link` — 连接因果边。单个: `id` + `caused_by`。批量: `links` 数组 [{id, caused_by}]。',
    '- `view` — 获取完整调查树。可选 `status_filter`。',
    '',
    '### 树结构',
    '- goal — 排查目标(你要查清什么)。',
    '- milestone — 待验证假设。写成可验证的判断语句, 而非分类标签:',
    '  - "Ceph 存储满了""DNS 解析异常""配置缺失" ← 合格',
    '  - "存储""网络""第一阶段" ← 不合格',
    '- step — 验证假设的具体动作。可嵌套于 milestone 或其他 step 下, 深度不限。',
    '',
    '### 下钻 — 核心纪律',
    '当一个 step 的发现引出新问题时, 在该 step 下嵌套子 step:',
    '  step: "查 OSD 使用率" → 发现 OSD-1 99% 满 → 下钻: "为什么 OSD-1 99% 满" → 再下钻: "查历史写入数据"',
    '',
    '嵌套深度就是调查路径。扁平的 step 列表丢失了"从症状到根因"的推理链, 嵌套的树则完整保留。',
    '',
    '### 输出格式',
    '- `create_tree`: 展示新树。',
    '- `add_step`/`add_milestone`: 展示新节点 + 父节点 + 统计行。',
    '- `start`/`complete`/`abandon`/`reopen`: 展示 `= id: 状态` + 统计行。',
    '- `link`: 展示 `~ id ← caused_by: ...` + 统计行。',
    '- `resolve`: 展示 `= goal: resolved` + 统计行。',
    '- `view`: 展示完整树。',
    '',
    '### 纪律',
    '- 每 5 步排查至少更新 1 次 trace。',
    '- 发现新问题: 在当前节点下嵌套子 step。',
    '- 死路: abandon — 探索路径比结果更重要。',
    '- 迷失方向: 调用 view。',
    '',
    '### 生命周期',
    '- 开始: create_tree 设定 goal。',
    '- 形成假设: 为每个待验证的判断 add_milestone。',
    '- 探索: 在对应 milestone 下 add_step, 完成后 complete 带 summary。',
    '- 下钻: 每个发现新问题的 step 下嵌套子 step。',
    '- 死路: abandon。解决: resolve 带 summary。',
    '- 新调查: 再次 create_tree — 前一棵树作为历史保留。',
  ].join('\n')

  // Register methodology and reminder through ops-prompts if available,
  // otherwise fall back to direct systemPrompt.section registration.
  const opsPrompts = ctx.get('opsPrompts')

  if (opsPrompts !== undefined) {
    // Register tool usage prompt as a methodology section
    opsPrompts.registerMethodology({
      name: 'trace:usage',
      order: 240,
      text: staticText,
    })

    // Register the idle reminder rule
    opsPrompts.registerReminder({
      name: 'trace:idle',
      check: (agent: unknown) => {
        const events = (agent as { session?: { events?: FoldEvent[] } })?.session?.events
        if (!events || events.length === 0) return null

        let currentStep = 0
        let lastTraceStep = 0
        let hasTree = false

        for (const ev of events) {
          if (ev.type === 'step/start') {
            currentStep = (ev.data?.turn ?? 0) * 1000 + (ev.data?.step ?? 0)
          }
          if (ev.type === 'tool/call' && ev.data?.name === 'trace') {
            lastTraceStep = currentStep
          }
          if (ev.type === 'tool/call' && ev.data?.name === 'trace') {
            try {
              const a = typeof ev.data?.arguments === 'string' ? JSON.parse(ev.data.arguments) : ev.data?.arguments
              if (a?.action === 'create_tree') hasTree = true
            } catch {}
          }
        }

        if (!hasTree || lastTraceStep === 0) return null
        const gap = currentStep - lastTraceStep
        if (gap < 5) return null

        return `[REMINDER] You haven't updated trace in ${gap} steps. Call \`trace view\` to check current state, then \`add_step\` or \`complete\` to record your progress.`
      },
    })
  } else {
    // Fallback: register directly if ops-prompts is not loaded
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      systemPrompt.section({
        name: 'tool:trace',
        order: 240,
        text: staticText,
      })
    }
  }
}

export { Config, apply, inject, name, foldEvent }
