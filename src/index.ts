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
} from './types.js'
import { activeTree, NODE_STATUSES } from './types.js'
import { SessionForestStore } from './session-forests.js'
import { buildReminderContext, createIdleRule, createNestingRule, ReminderLatch } from './reminders.js'
import type { ReminderContext } from './reminders.js'
import { HELP_TEXT, STATIC_PROMPT, TOOL_DESCRIPTION, TRIGGER_NODE_RULE } from './doctrine.js'
import { buildTreeIndex, sortChildren } from './tree-layout.js'

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
          parent: null, turns: [turn], summary: null, detail: null, caused_by: [],
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
          parent: args.parent_id, turns: [turn], summary: null,
          detail: args.detail ?? null, caused_by: [],
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

// ── Tool description & doctrine ─────────────────────────────────────────────
// The doctrine sentences live in src/doctrine.ts — one home per idea; the
// tool description, help text, system-prompt core, and reminders all compose
// from it.

// ── Projection schema (validates the view for client transport) ─────────────

// Exported so tests/contract.spec.ts can assert the three node-shape
// declarations (TreeNode interface, this schema, treeNodeJsonSchema) agree.
export const treeNodeSchema = zod.object({
  id: zod.string(),
  title: zod.string(),
  status: zod.enum(NODE_STATUSES),
  parent: zod.string().nullable(),
  turns: zod.array(zod.number()),
  summary: zod.string().nullable(),
  detail: zod.string().nullable(),
  caused_by: zod.array(zod.string()),
})

// Compile-time guard: the zod projection schema and the TreeNode interface
// must stay the same shape (mutual structural assignability).
type _TreeNodeMatchesSchema =
  zod.infer<typeof treeNodeSchema> extends TreeNode
    ? TreeNode extends zod.infer<typeof treeNodeSchema> ? true : never
    : never
const _treeNodeMatchesSchema: _TreeNodeMatchesSchema = true
void _treeNodeMatchesSchema

/**
 * JSON-schema shape of one node, for the tool's output contract. The third
 * declaration of the node shape (after the TreeNode interface and
 * treeNodeSchema above) — its status enum derives from NODE_STATUSES, and
 * tests/contract.spec.ts asserts all three field sets agree.
 */
export const treeNodeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: [...NODE_STATUSES] },
    parent: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    turns: { type: 'array', required: true, items: { type: 'number' } },
    summary: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    detail: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    caused_by: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

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

// Sibling ordering, tree indexing, depth, and DFS flattening live in
// src/tree-layout.ts — shared verbatim with the web client, so the human
// sees the same layout the model sees.

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
    // Inline detail (creation rationale)
    if (node.detail) {
      line += `  detail: ${node.detail}`
    }
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
  if (summary.warning) parts.push('WARN: ' + summary.warning)
  return parts.join(' | ')
}

/**
 * Render a single node line (inline caused_by + summary).
 */
function renderNodeLine(node: TreeNode, marker: string): string {
  const label = STATUS_LABEL[node.status] || ''
  const labelStr = label ? `${label} ` : ''
  let line = `${marker} ${node.id}: ${labelStr}${node.title}`
  if (node.detail) {
    line += `  detail: ${node.detail}`
  }
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

  // help: full usage documentation, no tree needed
  if (action === 'help') return HELP_TEXT

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
      stateVersion: 3,
    })
  })

  // The store owns the in-process forest map and the seeding protocol; the
  // projection registry only feeds it snapshots.
  const store = new SessionForestStore(
    (session) => {
      if (!projectionRegistry) return null
      return projectionRegistry.snapshot(session).values?.trace ?? null
    },
    foldEvent,
    (message) => ctx.logger('ops-trace').warn(message),
  )

  // Clean up in-process tree state when the plugin's fiber is disposed
  // (process restart, preset unmount); the store re-seeds from the projection
  // on next access.
  ctx.effect(() => () => { store.clear() })

  // ── Register model tool (06) ──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trace',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: [
        'create_tree', 'add_step', 'add_milestone',
        'start', 'complete', 'abandon', 'reopen', 'resolve', 'link', 'view', 'help',
      ], description: 'The action to perform. help returns the full usage documentation.' },

      goal_title: { type: 'string', description: 'Title for the investigation goal (create_tree only).' },

      id: { type: 'string', description: 'Node id. For add_step/add_milestone: the new node\'s semantic id (e.g. "ceph-full"). For start/complete/abandon/reopen: single target node. For link: target node (use with caused_by).' },
      parent_id: { type: 'string', description: `Parent node id (add_step/add_milestone only). ${TRIGGER_NODE_RULE}` },
      title: { type: 'string', description: 'Node title (add_step/add_milestone only).' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of node ids for batch mode (start/complete/abandon/reopen).',
      },

      summary: { type: 'string', description: 'How the goal/node was resolved. Required for resolve. Optional for complete — records what was found/fixed. add_step/add_milestone 的创建依据用 detail, 不是 summary。' },

      detail: { type: 'string', description: 'Creation rationale (add_step/add_milestone only): 假设的 "因为 Y" 分句, 或 step 的具体查证对象。' },

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

      // 'goal' is structural, not a status you'd filter by.
      status_filter: { type: 'string', enum: NODE_STATUSES.filter((s) => s !== 'goal'), description: 'Filter view to nodes of one status (view only, optional).' },
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
                items: treeNodeJsonSchema,
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
                properties: Object.fromEntries(
                  NODE_STATUSES.map((s) => [s, { type: 'integer', required: true }]),
                ) as Record<NodeStatus, { type: 'integer', required: true }>,
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
                    status: { type: 'string', required: true, enum: [...NODE_STATUSES] },
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
      const session = (agent.session ?? { id: sessionId }) as { id: string }

      // All state access goes through the store: it owns the map, the
      // projection seeding, and the mutation critical section.
      const activeNode = () => activeTree(store.current(session).forest)

      // The command tail every mutating action shares: apply through the
      // store's critical section, then summarize the resulting active tree.
      const applyAndSummarize = (): TraceResult => {
        const tree = activeTree(store.apply(session, args, turn))!
        return { tree, summary: buildSummary(tree) }
      }

      switch (args.action as TraceAction) {
        case 'create_tree': {
          if (!args.goal_title) throw new Error('trace: goal_title is required for create_tree')
          return applyAndSummarize()
        }

        case 'add_step':
        case 'add_milestone': {
          const tree = activeNode()
          if (!tree) throw new Error('trace: no tree — call create_tree first')
          if (!args.parent_id) throw new Error('trace: parent_id is required')
          if (!args.title) throw new Error('trace: title is required')
          if (!args.id) throw new Error('trace: id is required')
          const parent = tree.nodes.find((n) => n.id === args.parent_id)
          if (!parent) throw new Error(`trace: parent node "${args.parent_id}" not found`)
          if (tree.nodes.some((n) => n.id === args.id)) {
            throw new Error(`trace: node id "${args.id}" already exists`)
          }

          const result = applyAndSummarize()
          result.new_node = args.id
          return result
        }

        case 'start':
        case 'complete':
        case 'abandon':
        case 'reopen': {
          const tree = activeNode()
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

          return applyAndSummarize()
        }

        case 'resolve': {
          const tree = activeNode()
          if (!tree) throw new Error('trace: no tree')
          if (args.id && args.id !== 'goal') {
            throw new Error(`trace: resolve 只用于整棵树收口(最终 goal), 不接受 id "${args.id}"; 证实假设用 complete 带 summary, 证伪用 abandon`)
          }
          if (!args.summary) throw new Error('trace: summary is required for resolve')
          const goal = tree.nodes.find((n) => n.id === 'goal')
          if (!goal) throw new Error('trace: no goal node to resolve')
          if (goal.status === 'resolved') {
            return { tree, summary: buildSummary(tree) }
          }
          if (!canTransition(goal.status, 'resolved')) {
            throw new Error(`trace: goal is "${goal.status}", cannot resolve`)
          }
          return applyAndSummarize()
        }

        case 'link': {
          const tree = activeNode()
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
            const node = tree.nodes.find((n) => n.id === link.id)
            return node && node.caused_by.includes(link.caused_by)
          })
          if (allExist) {
            return { tree, summary: buildSummary(tree) }
          }

          return applyAndSummarize()
        }

        case 'view': {
          const tree = activeNode()
          if (!tree) throw new Error('trace: no tree — call create_tree first')
          if (args.status_filter) {
            const filtered: TreeState = {
              resolved: tree.resolved,
              nodes: tree.nodes.filter((n) =>
                n.parent === null || n.id === 'goal' || n.status === args.status_filter
              ),
            }
            return { tree: filtered, summary: buildSummary(tree) }
          }
          return { tree, summary: buildSummary(tree) }
        }

        case 'help': {
          // No state change — the render layer answers with HELP_TEXT.
          const tree = activeNode()
          return { tree: tree ?? { nodes: [], resolved: false }, summary: buildSummary(tree) }
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
  // Minimal always-on core, composed in src/doctrine.ts: what the tree is,
  // the trigger-node rule, and a pointer to the full documentation.
  const staticText = STATIC_PROMPT

  // Register methodology and reminders through ops-prompts. The preset mounts
  // the group's plugins concurrently, so a one-shot ctx.get can lose the race
  // against ops-prompts' provide — fall back to ctx.inject, which defers until
  // the service arrives.
  //
  // Reminder rules are pure functions of a derived ReminderContext; the latches
  // live here because they belong to the registration, not the rule.
  const idleRule = createIdleRule(new ReminderLatch(5, 5))
  const nestingRule = createNestingRule(new ReminderLatch(1, 5))
  const runRule = (rule: (ctx: ReminderContext) => string | null) => (agent: unknown): string | null => {
    const ctx = buildReminderContext(agent, store)
    return ctx === null ? null : rule(ctx)
  }

  const registerThroughHandle = (opsPrompts: OpsPromptsHandle): void => {
    // Register tool usage prompt as a methodology section
    opsPrompts.registerMethodology({
      name: 'trace:usage',
      order: 240,
      text: staticText,
    })

    opsPrompts.registerReminder({ name: 'trace:idle', check: runRule(idleRule) })
    opsPrompts.registerReminder({ name: 'trace:nesting', check: runRule(nestingRule) })
  }

  const immediateOpsPrompts = ctx.get('opsPrompts')
  if (immediateOpsPrompts !== undefined) {
    registerThroughHandle(immediateOpsPrompts)
  } else {
    // No direct systemPrompt fallback: the bundle patch also mounts this
    // plugin host-plane (for client-bundle discovery), where ops-prompts
    // never arrives — a fallback section registered there would stay forever
    // and duplicate the methodology text in every prompt. When ops-prompts is
    // genuinely absent, the tool description and the help action still carry
    // the usage documentation.
    ctx.inject(['opsPrompts'], (pctx: Context) => {
      registerThroughHandle(pctx.opsPrompts!)
    })
  }
}

export { Config, apply, inject, name, foldEvent }
