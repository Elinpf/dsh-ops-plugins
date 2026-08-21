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
const inject = ['tools', 'systemPrompt']

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Schemastery configuration for the ops-todo-tree tool consumer.
 */
const Config = z.object({})

// ── State machine (05) ───────────────────────────────────────────────────────

/** Legal status transitions. Key = from-status, value = set of allowed to-statuses. */
const TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  goal: ['in_progress', 'done', 'resolved'],
  pending: ['in_progress'],
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
        parent: null, turns: [data.turn], detail: null, summary: null,
      })
      nodes.push({
        id: data.goal_id, title: data.goal_title, status: 'goal',
        parent: data.root_id, turns: [data.turn], detail: null, summary: null,
      })
      return { nodes, resolved: false }
    }

    case 'todo_tree/add': {
      nodes.push({
        id: data.node_id, title: data.title,
        status: data.kind === 'milestone' ? 'goal' : 'pending',
        parent: data.parent_id, turns: [data.turn], detail: null, summary: null,
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
      return updateNode(state, data.node_id, data.turn, (n) => { n.status = newStatus })
    }

    case 'todo_tree/resolve': {
      const updated = updateNode(state, data.goal_id, data.turn, (n) => {
        n.status = 'resolved'
        n.summary = data.summary
      })
      return updated ? { ...updated, resolved: true } : state
    }

    case 'todo_tree/note': {
      return updateNode(state, data.node_id, data.turn, (n) => { n.detail = data.detail })
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
  const incomplete = nodes
    .filter((n) => n.status === 'goal' || n.status === 'pending' || n.status === 'in_progress')
    .map((n) => ({ id: n.id, title: n.title, status: n.status }))
  const warning = incomplete.length > 0 && tree?.resolved
    ? `${incomplete.length} node(s) still incomplete`
    : null
  return { total: nodes.length, counts, incomplete, warning }
}

// ── Tool description ─────────────────────────────────────────────────────────

const TOOL_DESCRIPTION = [
  'Maintain an investigation tree for incident response. ',
  'Create the tree at the start of an incident, add steps and milestones as you investigate, ',
  'mark dead ends (they stay on the tree — the full exploration trail is preserved), ',
  'and resolve when the incident is resolved. ',
  'Actions: create_tree, add_step, add_milestone, start, complete, abandon, resolve, note. ',
  'Use branch=true on add_step/add_milestone when exploring a side path. ',
  'The tree persists for the session and helps you stay oriented — every call returns the full tree and a status summary.',
].join('')

// ── Projection schema (validates the view for client transport) ─────────────

const treeNodeSchema = zod.object({
  id: zod.string(),
  title: zod.string(),
  status: zod.enum(['goal', 'pending', 'in_progress', 'done', 'dead_end', 'resolved']),
  parent: zod.string().nullable(),
  turns: zod.array(zod.number()),
  detail: zod.string().nullable(),
  summary: zod.string().nullable(),
})

const treeStateSchema = zod.object({
  nodes: zod.array(treeNodeSchema),
  resolved: zod.boolean(),
})

const todoTreeProjectionSchema = zod.union([treeStateSchema, zod.null()])

// ── Tree renderer (model-visible output) ─────────────────────────────────────

/** Render the full tree as text so the model can see every node's id and status. */
function renderTree(value: any): string {
  if (!value || !value.tree || !value.tree.nodes || value.tree.nodes.length === 0) {
    return 'No tree — call create_tree first.'
  }

  const tree: TreeState = value.tree
  const summary = value.summary
  const lines: string[] = []

  // Summary line
  if (summary) {
    const parts = [
      `${summary.total} nodes`,
      `${summary.counts?.in_progress || 0} in_progress`,
      `${summary.counts?.done || 0} done`,
      `${summary.counts?.dead_end || 0} dead_end`,
    ]
    if (tree.resolved) parts.push('✅ RESOLVED')
    if (summary.warning) parts.push('⚠ ' + summary.warning)
    lines.push(parts.join(' | '))
  }

  // Build child map for tree rendering
  const children: Record<string, TreeNode[]> = {}
  let root: TreeNode | null = null
  for (const n of tree.nodes) {
    if (n.parent === null) {
      root = n
    } else {
      if (!children[n.parent]) children[n.parent] = []
      children[n.parent].push(n)
    }
  }

  // Render tree with indentation
  function renderNode(node: TreeNode, indent: string, isLast: boolean): void {
    const prefix = indent + (isLast ? '└─ ' : '├─ ')
    let line = `${prefix}[${node.status}] ${node.id}: ${node.title}`
    if (node.detail) line += `  📝 ${node.detail}`
    if (node.summary) line += `  ✅ ${node.summary}`
    if (node.turns?.length) line += `  (turn ${node.turns.join(',')})`
    lines.push(line)

    const kids = children[node.id] || []
    const childIndent = indent + (isLast ? '   ' : '│  ')
    for (let i = 0; i < kids.length; i++) {
      renderNode(kids[i], childIndent, i === kids.length - 1)
    }
  }

  if (root) {
    renderNode(root, '', true)
  }

  return lines.join('\n')
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
        'start', 'complete', 'abandon', 'resolve', 'note',
      ], description: 'The action to perform.' },

      // create_tree
      root_title: { type: 'string', description: 'Title for the root problem (create_tree only).' },
      goal_title: { type: 'string', description: 'Title for the final goal (create_tree only).' },

      // add_step / add_milestone
      parent_id: { type: 'string', description: 'Parent node id (add_step/add_milestone only).' },
      title: { type: 'string', description: 'Node title (add_step/add_milestone only).' },
      branch: { type: 'boolean', description: 'Branch to a new lane (add_step/add_milestone only, default false).' },

      // start / complete / abandon / note
      node_id: { type: 'string', description: 'Target node id (start/complete/abandon/note only).' },

      // resolve
      summary: { type: 'string', description: 'How the goal was achieved (resolve only, required).' },

      // note
      detail: { type: 'string', description: 'Detail text (note only).' },
    },

    output: {
      schema: { type: 'json' },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: renderTree(value),
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
          if (!args.title) throw new Error('todo_tree: title is required')
          const parent = currentTree.nodes.find((n) => n.id === args.parent_id)
          if (!parent) throw new Error(`todo_tree: parent node "${args.parent_id}" not found`)
          const nodeId = generateId()
          const kind = args.action === 'add_milestone' ? 'milestone' : 'step'
          eventType = 'todo_tree/add'
          eventData = {
            turn, node_id: nodeId, parent_id: args.parent_id,
            title: args.title, kind, branch: args.branch ?? false,
          }
          break
        }

        case 'start':
        case 'complete':
        case 'abandon': {
          if (!currentTree) throw new Error('todo_tree: no tree')
          if (!args.node_id) throw new Error('todo_tree: node_id is required')
          const node = currentTree.nodes.find((n) => n.id === args.node_id)
          if (!node) throw new Error(`todo_tree: node "${args.node_id}" not found`)
          const targetStatus: NodeStatus =
            args.action === 'start' ? 'in_progress'
            : args.action === 'complete' ? 'done'
            : 'dead_end'
          if (!canTransition(node.status, targetStatus)) {
            throw new Error(`todo_tree: cannot transition from "${node.status}" to "${targetStatus}"`)
          }
          const eventMap: Record<string, string> = {
            start: 'todo_tree/start', complete: 'todo_tree/complete', abandon: 'todo_tree/abandon',
          }
          eventType = eventMap[args.action]
          eventData = { turn, node_id: args.node_id }
          break
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

        case 'note': {
          if (!currentTree) throw new Error('todo_tree: no tree')
          if (!args.node_id) throw new Error('todo_tree: node_id is required')
          if (!args.detail) throw new Error('todo_tree: detail is required for note')
          const node = currentTree.nodes.find((n) => n.id === args.node_id)
          if (!node) throw new Error(`todo_tree: node "${args.node_id}" not found`)
          eventType = 'todo_tree/note'
          eventData = { turn, node_id: args.node_id, detail: args.detail }
          break
        }

        default:
          throw new Error(`todo_tree: unknown action "${args.action}"`)
      }

      // Append the event to the session log
      agent.session.append(eventType, eventData)

      // Compute the return value by folding the event locally — the projection's
      // eager fold may not have run yet, so we cannot rely on getSnapshot().
      const updated = foldEvent(currentTree, { type: eventType, data: eventData })
      return { tree: updated, summary: buildSummary(updated) }
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
  ctx.systemPrompt.section({
    name: 'tool:todo_tree',
    order: 240,
    text: [
      '## todo_tree — Investigation Tree',
      '',
      'Use `todo_tree` to maintain an investigation tree for the current incident response.',
      'Unlike a flat todo list, the tree records the full exploration trail — dead ends stay visible, branches show parallel paths.',
      '',
      '### Actions',
      '- `create_tree` — Create the tree with a root problem and a final goal. Call this once at the start.',
      '- `add_step` — Add a concrete step as a child of an existing node. Set `branch=true` for a side path.',
      '- `add_milestone` — Add a milestone (more stable than a step, uses dashed connectors).',
      '- `start` — Mark a node as in_progress.',
      '- `complete` — Mark a node as done.',
      '- `abandon` — Mark a node as a dead end (it stays on the tree; you can re-explore later).',
      '- `resolve` — Mark the final goal as resolved. Requires a `summary` of how it was achieved.',
      '- `note` — Add detail text to a node.',
      '',
      '### When to use',
      '- At the start of an incident: `create_tree` with the problem and the goal.',
      '- Before investigating: `add_step` for each concrete check you plan to do.',
      '- When a path doesn\'t work: `abandon` it (it stays visible — dead ends are part of the record).',
      '- When delegating to subagents: after receiving results, use `add_step` with `branch=true` to record what they found.',
      '- When resolved: `resolve` with a summary of root cause and fix.',
      '',
      'Every call returns the full tree and a status summary. Use it to stay oriented.',
    ].join('\n'),
  })
}

export { Config, apply, inject, name }
