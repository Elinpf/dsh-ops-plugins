/**
 * Ops-todo-tree: an investigation tree tool that replaces `todo_write` in the ops preset.
 *
 * Agent-driven, append-only event log, tree + unique resolved convergence terminal.
 * See `.scratch/ops-todo-tree/research/` for the full design.
 *
 * @module @deepseek-ai/dsh-ops-todo-tree
 */

import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'

// ── Types (import type so they erase at runtime) ─────────────────────────────

import type {
  NodeStatus,
  TreeState,
  TreeNode,
  TodoTreeAction,
  TodoTreeResult,
} from './types.ts'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-todo-tree'
const inject = ['tools']

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Schemastery configuration for the ops-todo-tree tool consumer.
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
function currentTurn(exec: any): number {
  const events = exec.agent?.session?.events
  if (!events) return 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') return events[i].data.turn
  }
  return 0
}

// ── Projection fold (09) ─────────────────────────────────────────────────────

/**
 * Fold one tool/call event into tree state (pure function, allocation-fresh).
 * The projection reads tool/call events where name === 'todo_tree' and
 * parses the arguments JSON to reconstruct the tree.
 * No custom session event types are needed — tool/call is a known type.
 */
function foldEvent(state: TreeState | null, event: any): TreeState | null {
  // Only fold tool/call events for the todo_tree tool
  if (event.type !== 'tool/call') return state
  const data = event.data
  if (data?.name !== 'todo_tree') return state

  // Parse arguments JSON string
  let args: any
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
      nodes.push({
        id: 'goal', title: args.goal_title, status: 'goal',
        parent: null, turns: [turn], summary: null, caused_by: [],
      })
      return { nodes, resolved: false }
    }

    case 'add_step':
    case 'add_milestone': {
      const kind = action === 'add_milestone' ? 'milestone' : 'step'
      // Batch: titles array
      const titles: string[] = Array.isArray(args.titles) ? args.titles : [args.title]
      const providedIds: (string | undefined)[] = Array.isArray(args.ids)
        ? args.ids
        : args.id ? [args.id] : Array(titles.length).fill(undefined)

      const existingIds = new Set(nodes.map((n) => n.id))
      let tree = state ? { ...state, nodes } : { nodes, resolved: false }
      for (let i = 0; i < titles.length; i++) {
        const t = titles[i]
        const nodeId = providedIds[i] || slugify(t, existingIds)
        existingIds.add(nodeId)
        tree = {
          ...tree,
          nodes: [...tree.nodes, {
            id: nodeId, title: t,
            status: kind === 'milestone' ? 'goal' : 'pending',
            parent: args.parent_id, turns: [turn], summary: null, caused_by: [],
          }],
        }
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
      const nodeIds: string[] = Array.isArray(args.node_ids) ? args.node_ids : [args.node_id]
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
        n.summary = args.summary
      })
      return updated ? { ...updated, resolved: true } : state
    }

    case 'link': {
      return updateNode(state ? { ...state, nodes } : null, args.node_id, turn, (n) => {
        if (!n.caused_by.includes(args.caused_by)) {
          n.caused_by = [...n.caused_by, args.caused_by]
        }
      })
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

function buildSummary(tree: TreeState | null): TodoTreeResult['summary'] {
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
  'Create the tree at the start, plan milestones for investigation phases, add steps as you investigate, ',
  'complete steps with a summary of findings, abandon steps that are no longer relevant, ',
  'and resolve when the incident is resolved. ',
  'Actions: create_tree, add_milestone, add_step, start, complete, abandon, reopen, resolve, link, view. ',
  'Batch: pass titles+ids arrays to add_step, node_ids array to start/complete/abandon. ',
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
function renderCompact(value: any, newNodeId?: string): string {
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
function renderFull(value: any): string {
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
function renderStats(value: any): string {
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
function renderOutput(args: any, value: any): string {
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
    // Show new node(s) + parent
    const newIds: string[] = value.new_node ? [value.new_node] : (value.new_nodes || [])
    for (const nid of newIds) {
      const node = tree.nodes.find((n) => n.id === nid)
      if (node) {
        lines.push(renderNodeLine(node, '+'))
        if (node.parent) {
          const parent = tree.nodes.find((n) => n.id === node.parent)
          if (parent) lines.push(`  parent: ${parent.id}`)
        }
      }
    }
  } else if (action === 'start' || action === 'complete' || action === 'abandon' || action === 'reopen') {
    // Show changed node(s)
    const nodeIds: string[] = Array.isArray(args.node_ids) ? args.node_ids : [args.node_id]
    for (const nid of nodeIds) {
      const node = tree.nodes.find((n) => n.id === nid)
      if (node) lines.push(renderNodeLine(node, '='))
    }
  } else if (action === 'link') {
    // Show changed node with its new caused_by
    const node = tree.nodes.find((n) => n.id === args.node_id)
    if (node) lines.push(renderNodeLine(node, '~'))
  } else if (action === 'resolve') {
    // Show resolved goal node
    const goal = tree.nodes.find((n) => n.id === 'goal')
    if (goal) lines.push(renderNodeLine(goal, '='))
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

function apply(ctx: any, _config: Record<string, never>): void {
  // ── Register session projection (09) ──────────────────────────────────────
  // Store the registry reference so the tool's execute can read the current
  // projection state via snapshot(session) — the host-side API (not faceOf,
  // which is client-only).
  let projectionRegistry: any = null
  ctx.inject(['sessionProjections'], (pctx: any) => {
    projectionRegistry = pctx.sessionProjections
    pctx.sessionProjections.register({
      key: 'todo_tree',
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
    name: 'todo_tree',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', enum: [
        'create_tree', 'add_step', 'add_milestone',
        'start', 'complete', 'abandon', 'reopen', 'resolve', 'link', 'view',
      ], description: 'The action to perform.' },

      // create_tree
      goal_title: { type: 'string', description: 'Title for the investigation goal (create_tree only).' },

      // add_step / add_milestone
      parent_id: { type: 'string', description: 'Parent node id (add_step/add_milestone only). Use "goal" for top-level milestones.' },
      title: { type: 'string', description: 'Node title (add_step/add_milestone only).' },
      id: { type: 'string', description: 'Semantic id for the new node (e.g. "ceph-full"). If omitted, auto-generated from title slug (e.g. "Check Ceph" → "check-ceph").' },
      titles: { type: 'array', items: { type: 'string' }, description: 'Array of titles to add multiple siblings at once (batch mode).' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Array of semantic ids, one per title. If omitted, auto-generated from each title.' },

      // start / complete / abandon / reopen / link
      node_id: { type: 'string', description: 'Target node id (start/complete/abandon/reopen/link only).' },
      node_ids: { type: 'array', items: { type: 'string' }, description: 'Array of node ids for batch mode (start/complete/abandon/reopen). Use instead of node_id to update multiple nodes at once.' },

      // resolve / complete (optional on complete)
      summary: { type: 'string', description: 'How the goal/node was resolved. Required for resolve. Optional for complete — records what was found/fixed.' },

      // link
      caused_by: { type: 'string', description: 'Node id that is the root cause of node_id (link only). Expresses: "node_id is caused by caused_by".' },

      // view
      status_filter: { type: 'string', enum: ['pending', 'in_progress', 'done', 'dead_end', 'resolved'], description: 'Filter view to nodes of one status (view only, optional). If omitted, shows all.' },
    },

    output: {
      schema: { type: 'json' },
      render: (args: any, value: any) => [{
        type: 'text',
        text: renderOutput(args, value),
      }],
    },

    async execute(args: any, exec: any): Promise<any> {
      const agent = exec.agent
      if (!agent) throw new Error('todo_tree requires an owning agent session')
      const turn = currentTurn(exec)
      const sessionId = agent.session?.id ?? agent.id ?? 'default'

      // Read current tree: prefer the in-process state (handles parallel calls
      // within the same turn); fall back to the projection snapshot (handles
      // session replay / first call after restart).
      let currentTree: TreeState | null = getSessionTree(sessionId)
      if (currentTree === null && projectionRegistry) {
        try {
          const snap = projectionRegistry.snapshot(agent.session)
          currentTree = snap?.values?.todo_tree ?? null
          if (currentTree) setSessionTree(sessionId, currentTree)
        } catch {
          currentTree = null
        }
      }
      switch (args.action as TodoTreeAction) {
        case 'create_tree': {
          if (!args.goal_title) throw new Error('todo_tree: goal_title is required for create_tree')
          // Idempotent: if a tree already exists (e.g. session replay),
          // return the existing tree instead of throwing.
          if (currentTree) {
            return { tree: currentTree, summary: buildSummary(currentTree) }
          }
          const ev = { type: 'tool/call', data: { name: 'todo_tree', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: any = { tree: updated, summary: buildSummary(updated) }
          return result
        }

        case 'add_step':
        case 'add_milestone': {
          if (!currentTree) throw new Error('todo_tree: no tree — call create_tree first')
          if (!args.parent_id) throw new Error('todo_tree: parent_id is required')
          if (!args.title && !args.titles) throw new Error('todo_tree: title (or titles array) is required')
          const parent = currentTree.nodes.find((n) => n.id === args.parent_id)
          if (!parent) throw new Error(`todo_tree: parent node "${args.parent_id}" not found`)

          // Validate ids don't already exist BEFORE folding
          const titles: string[] = Array.isArray(args.titles) ? args.titles : [args.title]
          const providedIds: (string | undefined)[] = Array.isArray(args.ids)
            ? args.ids
            : args.id ? [args.id] : Array(titles.length).fill(undefined)
          if (providedIds.length !== titles.length) {
            throw new Error(`todo_tree: ids array must have exactly ${titles.length} entry(ies) to match titles.`)
          }

          const existingIds = new Set(currentTree.nodes.map((n) => n.id))
          const addedIds: string[] = []
          for (let i = 0; i < titles.length; i++) {
            const nodeId = providedIds[i] || slugify(titles[i], existingIds)
            if (existingIds.has(nodeId)) {
              throw new Error(`todo_tree: node id "${nodeId}" already exists`)
            }
            existingIds.add(nodeId)
            addedIds.push(nodeId)
          }

          const ev = { type: 'tool/call', data: { name: 'todo_tree', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)

          const result: any = { tree: updated, summary: buildSummary(updated) }
          if (addedIds.length === 1) result.new_node = addedIds[0]
          else result.new_nodes = addedIds
          return result
        }

        case 'start':
        case 'complete':
        case 'abandon':
        case 'reopen': {
          if (!currentTree) throw new Error('todo_tree: no tree')
          if (!args.node_id && !args.node_ids) throw new Error('todo_tree: node_id (or node_ids array) is required')
          const targetStatus: NodeStatus =
            args.action === 'start' || args.action === 'reopen' ? 'in_progress'
            : args.action === 'complete' ? 'done'
            : 'dead_end'

          // Validate transitions — idempotent if already at target status
          const nodeIds: string[] = Array.isArray(args.node_ids) ? args.node_ids : [args.node_id]
          for (const nid of nodeIds) {
            const node = currentTree.nodes.find((n) => n.id === nid)
            if (!node) throw new Error(`todo_tree: node "${nid}" not found`)
            if (node.status === targetStatus) continue // idempotent — already at target
            if (!canTransition(node.status, targetStatus)) {
              throw new Error(`todo_tree: cannot transition "${nid}" from "${node.status}" to "${targetStatus}"`)
            }
          }

          const ev = { type: 'tool/call', data: { name: 'todo_tree', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: any = { tree: updated, summary: buildSummary(updated) }
          return result
        }

        case 'resolve': {
          if (!currentTree) throw new Error('todo_tree: no tree')
          if (!args.summary) throw new Error('todo_tree: summary is required for resolve')
          const goal = currentTree.nodes.find((n) => n.id === 'goal')
          if (!goal) throw new Error('todo_tree: no goal node to resolve')
          if (goal.status === 'resolved') {
            return { tree: currentTree, summary: buildSummary(currentTree) }
          }
          if (!canTransition(goal.status, 'resolved')) {
            throw new Error(`todo_tree: goal is "${goal.status}", cannot resolve`)
          }
          const ev = { type: 'tool/call', data: { name: 'todo_tree', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: any = { tree: updated, summary: buildSummary(updated) }
          return result
        }

        case 'link': {
          if (!currentTree) throw new Error('todo_tree: no tree')
          if (!args.node_id) throw new Error('todo_tree: node_id is required for link')
          if (!args.caused_by) throw new Error('todo_tree: caused_by is required for link')
          const node = currentTree.nodes.find((n) => n.id === args.node_id)
          if (!node) throw new Error(`todo_tree: node "${args.node_id}" not found`)
          const target = currentTree.nodes.find((n) => n.id === args.caused_by)
          if (!target) throw new Error(`todo_tree: node "${args.caused_by}" not found`)
          if (node.caused_by.includes(args.caused_by)) {
            return { tree: currentTree, summary: buildSummary(currentTree) }
          }
          const ev = { type: 'tool/call', data: { name: 'todo_tree', turn, arguments: JSON.stringify(args) } }
          const updated = foldEvent(currentTree, ev)
          setSessionTree(sessionId, updated)
          const result: any = { tree: updated, summary: buildSummary(updated) }
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
            return { tree: filtered, summary: buildSummary(currentTree) }
          }
          return { tree: currentTree, summary: buildSummary(currentTree) }
        }

        default:
          throw new Error(`todo_tree: unknown action "${args.action}"`)
      }
      // Unreachable — all cases return directly
      throw new Error('todo_tree: unreachable')
    },

    presentCall: (args: any) => ({
      card: 'generic',
      title: args.action === 'create_tree' ? 'Create investigation tree'
        : args.action === 'add_step' ? 'Add step'
        : args.action === 'add_milestone' ? 'Add milestone'
        : args.action === 'resolve' ? 'Resolve'
        : args.action?.charAt(0).toUpperCase() + args.action.slice(1),
      kind: 'other',
      rawInput: args,
    }),
  }))

  // ── System prompt section ──────────────────────────────────────────────────
  // Static documentation (always present)
  const staticText = [
    '## todo_tree — Investigation Tree',
    '',
    'Use `todo_tree` to maintain an investigation tree for the current incident response.',
    'Unlike a flat todo list, the tree records the full exploration trail — dead ends stay visible, branches show parallel paths.',
    '',
    '### Actions',
    '- `create_tree` — Create the tree with a goal (investigation target). Call this once at the start.',
    '- `add_milestone` — Add a milestone as a fixed anchor under goal. Milestones organize investigation phases (e.g. "confirm storage root cause", "fix storage layer").',
    '- `add_step` — Add a step under a milestone (or another step). Steps are flexible investigation paths. Optional `id` for semantic id; if omitted, auto-generated from title. Batch: pass titles+ids arrays.',
    '- `start` — Mark a step as in_progress. Accepts node_ids array for batch.',
    '- `complete` — Mark a step as done (can skip start). Optional `summary` to record what was found/fixed. `done` means this step\'s investigation is complete, NOT that the conclusion is final. Accepts node_ids array for batch.',
    '- `abandon` — Mark a step as no longer needed. This includes dead ends (didn\'t work) AND changed circumstances (situation shifted, this check is no longer relevant). The step stays on the tree for the record. Accepts node_ids array for batch.',
    '- `reopen` — Reactivate a `done` or `dead_end` node back to in_progress. Use when a completed step\'s conclusion turns out to be wrong or incomplete and needs re-investigation.',
    '- `resolve` — Mark the goal as resolved. Requires a `summary`.',
    '- `link` — Connect a causal edge: `node_id` is caused by `caused_by`. Use when one symptom\'s root cause is another node (e.g. cred-broker is caused_by postgres). The tree keeps its parent structure; link adds a causal edge on top.',
    '- `view` — Retrieve the full tree with summaries and causal edges. Optional `status_filter` to show only one status.',
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
    '- `start`/`complete`/`abandon`/`reopen`: shows the changed node + stats line.',
    '- `link`: shows the changed node with its caused_by + stats line.',
    '- `resolve`: shows the resolved goal + stats line.',
    '- `view`: shows the full tree with all details.',
    'Use `view` when you need to see the full tree.',
    '',
    '### Discipline',
    '- **Every 5 steps of investigation, at least 1 todo_tree update.**',
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
  const opsPrompts = ctx.get('opsPrompts') as any | undefined

  if (opsPrompts !== undefined) {
    // Register tool usage prompt as a methodology section
    opsPrompts.registerMethodology({
      name: 'todo_tree:usage',
      order: 240,
      text: staticText,
    })

    // Register the idle reminder rule
    opsPrompts.registerReminder({
      name: 'todo_tree:idle',
      check: (agent: any) => {
        const events = agent?.session?.events
        if (!events || events.length === 0) return null

        let currentStep = 0
        let lastTodoTreeStep = 0
        let hasTree = false

        for (const ev of events) {
          if (ev.type === 'step/start') {
            currentStep = (ev.data?.turn ?? 0) * 1000 + (ev.data?.step ?? 0)
          }
          if (ev.type === 'tool/call' && ev.data?.name === 'todo_tree') {
            lastTodoTreeStep = currentStep
          }
          if (ev.type === 'tool/call' && ev.data?.name === 'todo_tree') {
            try {
              const a = typeof ev.data?.arguments === 'string' ? JSON.parse(ev.data.arguments) : ev.data?.arguments
              if (a?.action === 'create_tree') hasTree = true
            } catch {}
          }
        }

        if (!hasTree || lastTodoTreeStep === 0) return null
        const gap = currentStep - lastTodoTreeStep
        if (gap < 5) return null

        return `[REMINDER] You haven't updated todo_tree in ${gap} steps. Call \`todo_tree view\` to check current state, then \`add_step\` or \`complete\` to record your progress.`
      },
    })
  } else {
    // Fallback: register directly if ops-prompts is not loaded
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      systemPrompt.section({
        name: 'tool:todo_tree',
        order: 240,
        text: staticText,
      })
    }
  }
}

export { Config, apply, inject, name }
