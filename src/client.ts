/**
 * Client half for ops-todo-tree: registers a `conversation.input.dock` entry
 * that renders a collapsible investigation-tree panel above the composer —
 * the same pattern as todo_write's TodoPanel and goal's GoalBar.
 *
 * The panel reads the `todo_tree` projection via useProjection (host-side
 * fold of tool/call events) and shows:
 * - Collapsed: icon + title + progress counts + chevron
 * - Expanded: the full tree as an indented text outline
 *
 * Bundled by esbuild into lib/client.js in the ModuleLoader lazy-CJS format.
 * React is an external (provided by the browser module table).
 *
 * @module @deepseek-ai/dsh-ops-todo-tree/client
 */

import { createElement as h, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  IconChecklistOutline14,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TreeState, TreeNode, NodeStatus } from './types.ts'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-todo-tree-client'
const inject = ['slots']

// ── Status labels ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<NodeStatus, string> = {
  goal: '',
  pending: 'pending',
  in_progress: 'in_progress',
  done: 'done',
  dead_end: 'dead_end',
  resolved: 'resolved',
}

// ── CSS (self-injected) ──────────────────────────────────────────────────────

const CSS = `
.dock-tree-root{border-top:1px solid var(--dsw-alias-border-primary,#e5e7eb);background:var(--dsw-alias-bg-primary,#fff)}
.dock-tree-header{display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;user-select:none;font-size:13px;color:var(--dsh-alias-text-primary,#1f2328)}
.dock-tree-header:hover{background:var(--dsw-alias-bg-hover,#f6f8fa)}
.dock-tree-icon{display:flex;align-items:center;color:var(--dsw-alias-text-secondary,#656d76)}
.dock-tree-title{font-weight:600}
.dock-tree-progress{color:var(--dsw-alias-text-secondary,#656d76);font-size:12px}
.dock-tree-chevron{margin-left:auto;color:var(--dsw-alias-text-tertiary,#848d97)}
.dock-tree-body{padding:0 12px 8px;max-height:300px;overflow:auto}
.dock-tree-line{font-size:13px;line-height:1.6;font-family:ui-monospace,monospace;white-space:pre;color:var(--dsh-alias-text-primary,#1f2328)}
.dock-tree-empty{padding:6px 12px;font-size:13px;color:var(--dsw-alias-text-tertiary,#848d97)}
`.trim()

let cssInjected = false
function injectCSS(): void {
  if (cssInjected || typeof document === 'undefined') return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'ops-todo-tree-dock'
  tag.textContent = CSS
  document.head.appendChild(tag)
  cssInjected = true
}

// ── Tree rendering ───────────────────────────────────────────────────────────

/** Build a depth map for indentation. */
function depthOf(nodes: TreeNode[], id: string, cache: Record<string, number> = {}): number {
  if (id in cache) return cache[id]
  const node = nodes.find(n => n.id === id)
  if (!node || node.parent === null) { cache[id] = 0; return 0 }
  const d = depthOf(nodes, node.parent, cache) + 1
  cache[id] = d
  return d
}

/** Render the full tree as indented text lines. */
function renderTreeText(tree: TreeState): string {
  const cache: Record<string, number> = {}
  const lines: string[] = []

  // Sort: goal first, then by parent chain depth, then by original order
  const sorted = [...tree.nodes].sort((a, b) => {
    const da = depthOf(tree.nodes, a.id, cache)
    const db = depthOf(tree.nodes, b.id, cache)
    if (da !== db) return da - db
    return 0
  })

  for (const node of sorted) {
    const depth = depthOf(tree.nodes, node.id, cache)
    const indent = '  '.repeat(depth)
    const prefix = depth === 0 ? '└── ' : '├── '
    const label = STATUS_LABEL[node.status]
    const labelStr = label ? `${label} ` : ''
    let line = `${indent}${prefix}${node.id}: ${labelStr}${node.title}`
    if (node.turns.length > 0) line += ` (turn ${node.turns.join(',')})`
    if (node.caused_by.length > 0) line += `  ← caused_by: ${node.caused_by.join(', ')}`
    if (node.summary) line += `  summary: ${node.summary}`
    lines.push(line)
  }

  if (tree.resolved) lines.push('=== RESOLVED ===')
  return lines.join('\n')
}

/** Progress summary: "N nodes | X done | Y in_progress | Z pending" */
function progressLabel(tree: TreeState): string {
  const counts: Record<string, number> = {}
  for (const n of tree.nodes) counts[n.status] = (counts[n.status] ?? 0) + 1
  const parts: string[] = [`${tree.nodes.length} nodes`]
  if (counts.done) parts.push(`${counts.done} done`)
  if (counts.in_progress) parts.push(`${counts.in_progress} active`)
  if (counts.pending) parts.push(`${counts.pending} pending`)
  if (counts.dead_end) parts.push(`${counts.dead_end} dead`)
  if (tree.resolved) parts.push('resolved')
  return parts.join(' | ')
}

// ── Dock component ───────────────────────────────────────────────────────────

interface DockProps {
  useProjection?: (key: string) => unknown | undefined
}

function TodoTreeDock(props: DockProps): any {
  let tree: TreeState | null = null
  try {
    if (props.useProjection) {
      const val = props.useProjection('todo_tree')
      tree = (val as TreeState | null | undefined) ?? null
    }
  } catch {
    tree = null
  }

  const [collapsed, setCollapsed] = useState(true)

  if (!tree || !tree.nodes || tree.nodes.length === 0) return null

  return h('div', { className: 'dock-tree-root' },
    h('div', {
      className: 'dock-tree-header',
      onClick: () => setCollapsed(v => !v),
      role: 'button',
      tabIndex: 0,
      'aria-expanded': !collapsed,
      onKeyDown: (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(v => !v) } },
    },
      h('span', { className: 'dock-tree-icon' }, h(IconChecklistOutline14)),
      h('span', { className: 'dock-tree-title' }, 'Investigation Tree'),
      h('span', { className: 'dock-tree-progress' }, progressLabel(tree)),
      h('span', { className: 'dock-tree-chevron' },
        collapsed ? h(IconChevronUpOutline14) : h(IconChevronDownOutline14),
      ),
    ),
    !collapsed && h('div', { className: 'dock-tree-body' },
      h('pre', { className: 'dock-tree-line' }, renderTreeText(tree)),
    ),
  )
}

// ── Client plugin apply ─────────────────────────────────────────────────────

function apply(ctx: Context): void {
  injectCSS()
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'ops-tree', order: 10 },
      TodoTreeDock,
    ),
  )
}

export { apply, inject, name }
