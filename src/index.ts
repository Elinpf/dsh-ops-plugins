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
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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
  done: ['dead_end'],
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
 * Fold one event into tree state (pure function, allocation-fresh).
 * Called by sessionProjections for each event in the log.
 */
function foldEvent(state: TreeState | null, event: any): TreeState | null {
  if (!event.type || !event.type.startsWith('todo_tree/')) return state
  const data = event.data
  const nodes = state?.nodes ? [...state.nodes] : []

  switch (event.type) {
    case 'todo_tree/create': {
      nodes.push({
        id: data.root_id, title: data.root_title, status: 'goal',
        parent: null, turns: [data.turn], summary: null, caused_by: [],
      })
      nodes.push({
        id: data.goal_id, title: data.goal_title, status: 'goal',
        parent: data.root_id, turns: [data.turn], summary: null, caused_by: [],
      })
      return { nodes, resolved: false }
    }

    case 'todo_tree/add': {
      nodes.push({
        id: data.node_id, title: data.title,
        status: data.kind === 'milestone' ? 'goal' : 'pending',
        parent: data.parent_id, turns: [data.turn], summary: null, caused_by: [],
      })
      return state ? { ...state, nodes } : { nodes, resolved: false }
    }

    case 'todo_tree/start':
    case 'todo_tree/complete':
    case 'todo_tree/abandon': {
      const newStatus: NodeStatus =
        event.type === 'todo_tree/start' ? 'in_progress'
        : event.type === 'todo_tree/complete' ? 'done'
        : 'dead_end'
      return updateNode(state, data.node_id, data.turn, (n) => {
        n.status = newStatus
        if (event.type === 'todo_tree/complete' && data.summary) n.summary = data.summary
      })
    }

    case 'todo_tree/resolve': {
      const updated = updateNode(state, data.goal_id, data.turn, (n) => {
        n.status = 'resolved'
        n.summary = data.summary
      })
      return updated ? { ...updated, resolved: true } : state
    }

    case 'todo_tree/link': {
      return updateNode(state, data.node_id, data.turn, (n) => {
        if (!n.caused_by.includes(data.caused_by)) {
          n.caused_by = [...n.caused_by, data.caused_by]
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
  // Incomplete = not done, not dead_end, not resolved, and not the root node.
  // The root and goal nodes are structural, not "incomplete" steps.
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
  'Structure: root (problem) → milestone (fixed phase anchor) → step (flexible investigation path). ',
  'Create the tree at the start, plan milestones for investigation phases, add steps as you investigate, ',
  'complete steps with a summary of findings, abandon steps that are no longer relevant, ',
  'and resolve when the incident is resolved. ',
  'Actions: create_tree, add_milestone, add_step, start, complete, abandon, reopen, resolve, link, view. ',
  'Use branch=true on add_step when exploring a side path. ',
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
    // goal always last
    const aIsGoal = a.id === 'goal' || (a.status === 'goal' && a.parent !== null)
    const bIsGoal = b.id === 'goal' || (b.status === 'goal' && b.parent !== null)
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
    lines.push(`${prefix}${connector}${node.id}: ${labelStr}${node.title}${turnStr}`)

    // Summary on separate indented line (from complete/resolve)
    const indent = prefix + (isLast ? '    ' : '│   ')
    if (node.caused_by.length > 0) {
      lines.push(`${indent}← caused_by: ${node.caused_by.join(', ')}`)
    }
    if (node.summary) {
      lines.push(`${indent}summary: ${node.summary}`)
    }

    const kids = sortChildren(children[node.id] || [])
    for (let i = 0; i < kids.length; i++) {
      renderNode(kids[i], indent, i === kids.length - 1)
    }
  }

  if (root) renderNode(root, '', true)

  return lines.join('\n')
}

/**
 * Decide what to render based on the action.
 * - create_tree / add_step / add_milestone / resolve: full compact tree
 *   (agent needs to see new node id and structure)
 * - view: full tree with details
 * - start / complete / abandon / reopen / note: one-line confirmation only
 *   (no tree — saves tokens on high-frequency status changes)
 */
function renderOutput(args: any, value: any): string {
  const action = args?.action
  if (action === 'view') return renderFull(value)

  // Simple status changes: return a short confirmation with total count
  if (action === 'start' || action === 'complete' || action === 'abandon'
      || action === 'reopen') {
    if (!value || !value.tree) return 'No tree — call create_tree first.'
    const summary = value.summary
    const parts: string[] = []
    const c = summary?.counts || {}
    parts.push(`${summary?.total || 0} nodes`)
    if (c.done) parts.push(`${c.done} done`)
    if (c.in_progress) parts.push(`${c.in_progress} in_progress`)
    if (c.pending) parts.push(`${c.pending} pending`)
    if (c.dead_end) parts.push(`${c.dead_end} dead_end`)
    if (value.tree.resolved) parts.push('resolved')
    return parts.join(' | ')
  }

  // create_tree, add_step, add_milestone, resolve: return compact tree
  return renderCompact(value, value?.new_node)
}

// ── Tool implementation ─────────────────────────────────────────────────────

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
      root_title: { type: 'string', description: 'Title for the root problem (create_tree only).' },
      goal_title: { type: 'string', description: 'Title for the final goal (create_tree only).' },

      // add_step / add_milestone
      parent_id: { type: 'string', description: 'Parent node id (add_step/add_milestone only).' },
      title: { type: 'string', description: 'Node title (add_step/add_milestone only).' },
      branch: { type: 'boolean', description: 'Branch to a new lane (add_step/add_milestone only, default false).' },
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

      // Read current tree from the projection registry (host-side API).
      // session.append() emits session/event synchronously, which drives
      // the projection fold synchronously, so snapshot() reflects all
      // previously-appended events.
      let currentTree: TreeState | null = null
      if (projectionRegistry) {
        try {
          const snap = projectionRegistry.snapshot(agent.session)
          currentTree = snap?.values?.todo_tree ?? null
        } catch {
          currentTree = null
        }
      }

      // The event we will append and the locally-folded result.
      // We compute the return value from the local fold, NOT from re-reading
      // the projection — session.append is synchronous but the projection's
      // eager fold may not have run yet, so getSnapshot() could return stale state.
      let eventType: string = ''
      let eventData: Record<string, unknown> = {}
      let newNodeId: string | undefined

      switch (args.action as TodoTreeAction) {
        case 'create_tree': {
          if (currentTree) throw new Error('todo_tree: tree already exists')
          if (!args.root_title) throw new Error('todo_tree: root_title is required for create_tree')
          if (!args.goal_title) throw new Error('todo_tree: goal_title is required for create_tree')
          eventType = 'todo_tree/create'
          eventData = {
            turn, root_id: 'root', root_title: args.root_title,
            goal_id: 'goal', goal_title: args.goal_title,
          }
          break
        }

        case 'add_step':
        case 'add_milestone': {
          if (!currentTree) throw new Error('todo_tree: no tree — call create_tree first')
          if (!args.parent_id) throw new Error('todo_tree: parent_id is required')
          if (!args.title && !args.titles) throw new Error('todo_tree: title (or titles array) is required')
          const parent = currentTree.nodes.find((n) => n.id === args.parent_id)
          if (!parent) throw new Error(`todo_tree: parent node "${args.parent_id}" not found`)
          const kind = args.action === 'add_milestone' ? 'milestone' : 'step'

          // Batch mode: titles array adds multiple siblings at once.
          const titles: string[] = Array.isArray(args.titles) ? args.titles : [args.title]
          if (titles.length === 0 || !titles[0]) throw new Error('todo_tree: title is required')

          // Semantic id: if provided (id or ids array), use it.
          // If not provided, auto-generate from title slug (e.g. "Check Ceph" → "check-ceph").
          const providedIds: (string | undefined)[] = Array.isArray(args.ids)
            ? args.ids
            : args.id ? [args.id] : Array(titles.length).fill(undefined)
          if (providedIds.length !== titles.length) {
            throw new Error(`todo_tree: ids array must have exactly ${titles.length} entry(ies) to match titles.`)
          }

          let tree: TreeState | null = currentTree
          const existingIds = new Set(currentTree.nodes.map((n) => n.id))
          const addedIds: string[] = []
          for (let i = 0; i < titles.length; i++) {
            const t = titles[i]
            // Use provided id, or auto-generate from title slug
            const nodeId = providedIds[i] || slugify(t, existingIds)
            existingIds.add(nodeId)
            if (tree!.nodes.some((n) => n.id === nodeId)) {
              throw new Error(`todo_tree: node id "${nodeId}" already exists`)
            }
            const ev = { type: 'todo_tree/add', data: { turn, node_id: nodeId, parent_id: args.parent_id, title: t, kind, branch: (args.branch ?? false) && i === 0 } }
            agent.session.append(ev.type, ev.data)
            tree = foldEvent(tree, ev)
            addedIds.push(nodeId)
          }
          // Return with last added id marked as new (or all if multiple)
          newNodeId = addedIds[addedIds.length - 1]
          const result: any = { tree, summary: buildSummary(tree) }
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

          // Batch mode: node_ids array to update multiple nodes at once
          const nodeIds: string[] = Array.isArray(args.node_ids) ? args.node_ids : [args.node_id]
          const eventMap: Record<string, string> = {
            start: 'todo_tree/start', complete: 'todo_tree/complete',
            abandon: 'todo_tree/abandon', reopen: 'todo_tree/start',
          }
          const evType = eventMap[args.action]

          let tree: TreeState | null = currentTree
          for (const nid of nodeIds) {
            const node = tree!.nodes.find((n) => n.id === nid)
            if (!node) throw new Error(`todo_tree: node "${nid}" not found`)
            if (!canTransition(node.status, targetStatus)) {
              throw new Error(`todo_tree: cannot transition "${nid}" from "${node.status}" to "${targetStatus}"`)
            }
            const evData: Record<string, unknown> = { turn, node_id: nid }
            if (args.action === 'complete' && args.summary) evData.summary = args.summary
            agent.session.append(evType, evData)
            tree = foldEvent(tree, { type: evType, data: evData })
          }
          const result: any = { tree, summary: buildSummary(tree) }
          return result
        }

        case 'resolve': {
          if (!currentTree) throw new Error('todo_tree: no tree')
          if (!args.summary) throw new Error('todo_tree: summary is required for resolve')
          const goal = currentTree.nodes.find((n) => n.status === 'goal' && n.parent !== null && n.id !== 'root')
            ?? currentTree.nodes.find((n) => n.id === 'goal')
          if (!goal) throw new Error('todo_tree: no final goal node to resolve')
          if (!canTransition(goal.status, 'resolved')) {
            throw new Error(`todo_tree: goal is "${goal.status}", cannot resolve`)
          }
          eventType = 'todo_tree/resolve'
          eventData = { turn, goal_id: goal.id, summary: args.summary }
          break
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
          eventType = 'todo_tree/link'
          eventData = { turn, node_id: args.node_id, caused_by: args.caused_by }
          break
        }

        case 'view': {
          // No event to append — just return the current tree in full format.
          // If status_filter is set, only include nodes matching that status
          // (plus the root and goal for context).
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

      // Append the event to the session log
      agent.session.append(eventType, eventData)

      // Compute the return value by folding the event locally — the projection's
      // eager fold may not have run yet, so we cannot rely on getSnapshot().
      const updated = foldEvent(currentTree, { type: eventType, data: eventData })
      const result: any = { tree: updated, summary: buildSummary(updated) }
      if (newNodeId) result.new_node = newNodeId
      return result
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
    '- `create_tree` — Create the tree with a root problem and a final goal. Call this once at the start.',
    '- `add_milestone` — Add a milestone as a fixed anchor under root or another milestone. Milestones organize investigation phases (e.g. "confirm storage root cause", "fix storage layer").',
    '- `add_step` — Add a step under a milestone (or another step). Steps are flexible investigation paths. Optional `id` for semantic id; if omitted, auto-generated from title. Batch: pass titles+ids arrays.',
    '- `start` — Mark a step as in_progress. Accepts node_ids array for batch.',
    '- `complete` — Mark a step as done (can skip start). Optional `summary` to record what was found/fixed. Accepts node_ids array for batch.',
    '- `abandon` — Mark a step as no longer needed. This includes dead ends (didn\'t work) AND changed circumstances (situation shifted, this check is no longer relevant). The step stays on the tree for the record. Accepts node_ids array for batch.',
    '- `reopen` — Reactivate an abandoned (dead_end) node back to in_progress.',
    '- `resolve` — Mark the final goal as resolved. Requires a `summary`.',
    '- `link` — Connect a causal edge: `node_id` is caused by `caused_by`. Use when one symptom\'s root cause is another node (e.g. cred-broker is caused_by postgres). The tree keeps its parent structure; link adds a causal edge on top.',
    '- `view` — Retrieve the full tree with summaries and causal edges. Optional `status_filter` to show only one status.',
    '',
    '### Tree structure',
    'root (problem) → milestone (fixed phase anchor) → step (flexible investigation path).',
    'Milestones are planned upfront and stay relatively stable.',
    'Steps are created and completed as you investigate; abandon steps that are no longer relevant.',
    'When you find something new, add_step — do not accumulate findings in a single node.',
    '',
    '### Output format',
    'Each call returns a compact tree: id + status + title, one line per node.',
    'Status: pending, in_progress, done, dead_end, resolved.',
    'New nodes from add_step/add_milestone are marked with *.',
    'Use `view` to see full details (summaries, turns).',
    '',
    '### Discipline',
    '- **Every 5 steps of investigation, at least 1 todo_tree update.**',
    '- **When you find something**: add_step to structure it, then complete with a summary.',
    '- **Unexpected branches**: when an investigation leads somewhere unplanned, immediately `add_step` with `branch=true`.',
    '- **Dead ends and changed plans**: `abandon` them — the full exploration trail is the record.',
    '- **Don\'t forget**: if you lose track of the tree, call `view`.',
    '',
    '### Lifecycle',
    '- At the start: `create_tree` with the problem and the goal.',
    '- Plan phases: `add_milestone` for each major investigation phase.',
    '- Investigate: `add_step` under the relevant milestone, then `complete` with a summary of findings.',
    '- When a path doesn\'t work: `abandon` it.',
    '- When resolved: `resolve` with a summary.',
  ].join('\n')

  ctx.systemPrompt.section({
    name: 'tool:todo_tree',
    order: 240,
    text: staticText,
  })

  // Inject reminder directly into the conversation flow via agent/pre-step.
  // systemPrompt.section is only re-read at prompt assembly (background noise);
  // agent/pre-step inserts a visible user-role message that the model sees each step.
  // This is the mechanism used by time-context, repeat-tool-reminder, and plan-mode.
  ctx.on('agent/pre-step', async (payload: any, next: any) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const agent = payload?.agent
    if (!agent) return decision
    const events = agent.session?.events
    if (!events || events.length === 0) return decision

    // Count steps since last todo_tree call using step/start events.
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
      if (ev.type === 'todo_tree/create') {
        hasTree = true
      }
    }

    if (!hasTree || lastTodoTreeStep === 0) return decision
    const gap = currentStep - lastTodoTreeStep
    if (gap < 5) return decision

    const text = `[REMINDER] You haven't updated todo_tree in ${gap} steps. Call \`todo_tree view\` to check current state, then \`add_step\` or \`complete\` to record your progress.`
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'notice', summary: `todo_tree idle ${gap} steps` },
        }),
      ],
    }
  }, { prepend: true })
}

export { Config, apply, inject, name }
