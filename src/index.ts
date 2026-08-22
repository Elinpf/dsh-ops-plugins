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
        init: () => TreeState | null
        apply: (state: TreeState | null, event: FoldEvent) => TreeState | null
        view: (state: TreeState | null) => TreeState | null
        stateVersion: number
      }): () => void
      snapshot(session: { id: string }): { values: { trace?: TreeState | null } }
    }
  }
}

import type {
  NodeStatus,
  TreeState,
  TreeNode,
  TraceAction,
  TraceResult,
  TraceArgs,
  LinkPair,
} from './types.ts'

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

function foldEvent(state: TreeState | null, event: FoldEvent): TreeState | null {
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
  const nodes = state?.nodes ? [...state.nodes] : []

  switch (action) {
    case 'create_tree': {
      // Idempotent: if a goal already exists (session replay), keep the original.
      if (nodes.some((n) => n.id === 'goal')) return state
      nodes.push({
        id: 'goal', title: args.goal_title!, status: 'goal',
        parent: null, turns: [turn], summary: null, caused_by: [],
      })
      return { nodes, resolved: false }
    }

    case 'add_step':
    case 'add_milestone': {
      const kind = action === 'add_milestone' ? 'milestone' : 'step'
      const existingIds = new Set(nodes.map((n) => n.id))
      const nodeId = args.id!
      existingIds.add(nodeId)
      let tree = state ? { ...state, nodes } : { nodes, resolved: false }
      tree = {
        ...tree,
        nodes: [...tree.nodes, {
          id: nodeId, title: args.title!,
          status: kind === 'milestone' ? 'goal' : 'pending',
          parent: args.parent_id!, turns: [turn], summary: null, caused_by: [],
        }],
      }
      return tree
    }

    case 'start':
    case 'complete':
    case 'abandon':
    case 'reopen': {
      const newStatus: NodeStatus =
        action === 'start' || action === 'reopen' ? 'in_progress'
        : action === 'complete' ? 'done'
        : 'dead_end'
      const nodeIds: string[] = Array.isArray(args.ids) ? args.ids : (args.id ? [args.id] : [])
      let tree: TreeState | null = state ? { ...state, nodes } : null
      for (const nid of nodeIds) {
        tree = updateNode(tree, nid, turn, (n) => {
          n.status = newStatus
          if (action === 'complete' && args.summary) n.summary = args.summary
        })
      }
      return tree
    }

    case 'resolve': {
      const goalId = 'goal'
      const updated = updateNode(state ? { ...state, nodes } : null, goalId, turn, (n) => {
        n.status = 'resolved'
        n.summary = args.summary!
      })
      return updated ? { ...updated, resolved: true } : state
    }

    case 'link': {
      // Support batch: links array [{id, caused_by}], or single {id, caused_by}
      const links: LinkPair[] = Array.isArray(args.links) ? args.links : [{id: args.id!, caused_by: args.caused_by!}]
      let tree = state ? { ...state, nodes } : null
      for (const link of links) {
        tree = updateNode(tree, link.id, turn, (n) => {
          if (!n.caused_by.includes(link.caused_by)) {
            n.caused_by = [...n.caused_by, link.caused_by]
          }
        })
      }
      return tree
    }

    default:
      return state
  }
}

/** Pure helper: copy nodes, find target, create new copy without mutating the original. */
function updateNode(
  state: TreeState | null,
  nodeId: string,
  turn: number,
  mutate: (n: TreeNode) => void,
): TreeState | null {
  if (!state) return state
  let found = false
  const nodes = state.nodes.map((n) => {
    if (n.id !== nodeId) return n
    found = true
    const copy: TreeNode = { ...n, turns: n.turns.includes(turn) ? n.turns : [...n.turns, turn] }
    mutate(copy)
    return copy
  })
  return found ? { ...state, nodes } : state
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
  'Maintain an investigation tree for incident response. ',
  'Structure: goal (investigation target) → milestone (fixed phase anchor) → step (flexible investigation path). ',
  'All node operations use `id` (or `ids` array for batch). ',
  'Actions: create_tree, add_milestone, add_step, start, complete, abandon, reopen, resolve, link, view. ',
  'The tree persists for the session and helps you stay oriented.',
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

const todoTreeProjectionSchema = zod.union([treeStateSchema, zod.null()])

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
const sessionTrees = new Map<string, TreeState>()

function getSessionTree(sessionId: string): TreeState | null {
  return sessionTrees.get(sessionId) ?? null
}

function setSessionTree(sessionId: string, tree: TreeState | null): void {
  if (tree === null) sessionTrees.delete(sessionId)
  else sessionTrees.set(sessionId, tree)
}

/** Minimal projection-registry interface used by this plugin. */
interface ProjectionRegistryLike {
  snapshot(session: { id: string }): { values: { trace?: TreeState | null } }
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
      schema: todoTreeProjectionSchema,
      init: () => null,
      apply: foldEvent,
      view: (s: TreeState | null) => s,
      stateVersion: 1,
    })
  })

  // Clean up in-process tree state when the plugin's fiber is disposed
  // (process restart, preset unmount). session/disposed is a Session-scoped
  // event we can't hear from the plugin's global ctx; instead, the execute
  // function falls back to the projection snapshot for session replay, so
  // stale entries in the map are harmless — they're overwritten on first
  // call and never cause cross-session contamination because the key is
  // the sessionId.
  ctx.effect(() => () => { sessionTrees.clear() })

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

      // Read current tree: prefer the in-process state (handles parallel calls
      // within the same turn); fall back to the projection snapshot (handles
      // session replay / first call after restart).
      let currentTree: TreeState | null = getSessionTree(sessionId)
      if (currentTree === null && projectionRegistry) {
        try {
          const snap = projectionRegistry.snapshot(agent.session)
          currentTree = snap?.values?.trace ?? null
          if (currentTree) setSessionTree(sessionId, currentTree)
        } catch {
          currentTree = null
        }
      }
      switch (args.action as TraceAction) {
        case 'create_tree': {
          if (!args.goal_title) throw new Error('trace: goal_title is required for create_tree')
          // Idempotent: if a tree already exists (e.g. session replay),
          // return the existing tree instead of throwing.
          if (currentTree) {
            return { tree: currentTree!, summary: buildSummary(currentTree!) }
          }
          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: TraceResult = { tree: updated!, summary: buildSummary(updated!) }
          return result
        }

        case 'add_step':
        case 'add_milestone': {
          if (!currentTree) throw new Error('trace: no tree — call create_tree first')
          if (!args.parent_id) throw new Error('trace: parent_id is required')
          if (!args.title) throw new Error('trace: title is required')
          if (!args.id) throw new Error('trace: id is required')
          const parent = currentTree.nodes.find((n) => n.id === args.parent_id)
          if (!parent) throw new Error(`trace: parent node "${args.parent_id}" not found`)
          if (currentTree.nodes.some((n) => n.id === args.id)) {
            throw new Error(`trace: node id "${args.id}" already exists`)
          }

          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)

          const result: TraceResult = { tree: updated!, summary: buildSummary(updated!) }
          result.new_node = args.id
          return result
        }

        case 'start':
        case 'complete':
        case 'abandon':
        case 'reopen': {
          if (!currentTree) throw new Error('trace: no tree')
          const nodeIds: string[] = Array.isArray(args.ids) ? args.ids : (args.id ? [args.id] : [])
          if (nodeIds.length === 0) throw new Error('trace: id (or ids array) is required')
          const targetStatus: NodeStatus =
            args.action === 'start' || args.action === 'reopen' ? 'in_progress'
            : args.action === 'complete' ? 'done'
            : 'dead_end'

          // Validate transitions — idempotent if already at target status
          for (const nid of nodeIds) {
            const node = currentTree.nodes.find((n) => n.id === nid)
            if (!node) throw new Error(`trace: node "${nid}" not found`)
            if (node.status === targetStatus) continue // idempotent — already at target
            if (!canTransition(node.status, targetStatus)) {
              throw new Error(`trace: cannot transition "${nid}" from "${node.status}" to "${targetStatus}"`)
            }
          }

          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: TraceResult = { tree: updated!, summary: buildSummary(updated!) }
          return result
        }

        case 'resolve': {
          if (!currentTree) throw new Error('trace: no tree')
          if (!args.summary) throw new Error('trace: summary is required for resolve')
          const goal = currentTree.nodes.find((n) => n.id === 'goal')
          if (!goal) throw new Error('trace: no goal node to resolve')
          if (goal.status === 'resolved') {
            return { tree: currentTree!, summary: buildSummary(currentTree!) }
          }
          if (!canTransition(goal.status, 'resolved')) {
            throw new Error(`trace: goal is "${goal.status}", cannot resolve`)
          }
          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: TraceResult = { tree: updated!, summary: buildSummary(updated!) }
          return result
        }

        case 'link': {
          if (!currentTree) throw new Error('trace: no tree')
          const links: LinkPair[] = Array.isArray(args.links) ? args.links : [{id: args.id!, caused_by: args.caused_by!}]
          if (links.length === 0) throw new Error('trace: at least one link is required')

          // Validate all nodes exist
          for (const link of links) {
            if (!link.id) throw new Error('trace: id is required for link')
            if (!link.caused_by) throw new Error('trace: caused_by is required for link')
            const node = currentTree.nodes.find((n) => n.id === link.id)
            if (!node) throw new Error(`trace: node "${link.id}" not found`)
            const target = currentTree.nodes.find((n) => n.id === link.caused_by)
            if (!target) throw new Error(`trace: node "${link.caused_by}" not found`)
          }

          // Check if all links already exist (idempotent)
          const allExist = links.every(link => {
            const node = currentTree!.nodes.find((n) => n.id === link.id)
            return node && node.caused_by.includes(link.caused_by)
          })
          if (allExist) {
            return { tree: currentTree!, summary: buildSummary(currentTree!) }
          }

          const ev = { type: 'tool/call', data: { name: 'trace', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: TraceResult = { tree: updated!, summary: buildSummary(updated!) }
          return result
        }

        case 'view': {
          if (args.status_filter && currentTree) {
            const filtered: TreeState = {
              resolved: currentTree.resolved,
              nodes: currentTree.nodes.filter((n) =>
                n.parent === null || n.id === 'goal' || n.status === args.status_filter
              ),
            }
            return { tree: filtered, summary: buildSummary(currentTree!) }
          }
          return { tree: currentTree!, summary: buildSummary(currentTree!) }
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
    '## trace — Trace',
    '',
    'Use `trace` to maintain an investigation tree for the current incident response.',
    'Unlike a flat todo list, the tree records the full exploration trail — dead ends stay visible, branches show parallel paths.',
    '',
    '### Actions',
    '- `create_tree` — Create the tree with a goal (investigation target). Call this once at the start. Requires `goal_title`.',
    '- `add_milestone` — Add a milestone as a fixed anchor under goal. Requires `id` (semantic id), `parent_id`, `title`.',
    '- `add_step` — Add a step under a milestone (or another step). Requires `id` (semantic id), `parent_id`, `title`.',
    '- `start` — Mark nodes as in_progress. Pass `id` (single) or `ids` array (batch).',
    '- `complete` — Mark nodes as done (can skip start). Optional `summary` to record what was found/fixed. Pass `id` or `ids` array.',
    '- `abandon` — Mark nodes as no longer needed (dead ends or changed circumstances). Pass `id` or `ids` array.',
    '- `reopen` — Reactivate a `done` or `dead_end` node back to in_progress. Pass `id` or `ids` array.',
    '- `resolve` — Mark the goal as resolved. Requires `summary`.',
    '- `link` — Connect causal edges. Single: pass `id` + `caused_by`. Batch: pass `links` array of {id, caused_by} pairs.',
    '- `view` — Retrieve the full tree with summaries and causal edges. Optional `status_filter`.',
    '',
    '### Tree structure',
    'goal (investigation target) → milestone (fixed phase anchor) → step (flexible investigation path).',
    'Milestones are planned upfront and stay relatively stable.',
    'Steps are created and completed as you investigate; abandon steps that are no longer relevant.',
    'When you find something new, add_step — do not accumulate findings in a single node.',
    '',
    '### Output format',
    '- `create_tree`: shows the new tree.',
    '- `add_step`/`add_milestone`: shows the new node + parent + stats line.',
    '- `start`/`complete`/`abandon`/`reopen`: shows `= id: status` + stats line.',
    '- `link`: shows `~ id ← caused_by: ...` + stats line.',
    '- `resolve`: shows `= goal: resolved` + stats line.',
    '- `view`: shows the full tree with all details.',
    '',
    '### Discipline',
    '- **Every 5 steps of investigation, at least 1 trace update.**',
    '- **When you find something**: add_step to structure it, then complete with a summary.',
    '- **Dead ends and changed plans**: `abandon` them — the full exploration trail is the record.',
    '- **Don\'t forget**: if you lose track of the tree, call `view`.',
    '',
    '### Lifecycle',
    '- At the start: `create_tree` with the goal.',
    '- Plan phases: `add_milestone` for each major investigation phase.',
    '- Investigate: `add_step` under the relevant milestone, then `complete` with a summary of findings.',
    '- When a path doesn\'t work: `abandon` it.',
    '- When resolved: `resolve` with a summary.',
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
