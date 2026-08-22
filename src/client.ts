/**
 * Client half for ops-trace: registers a `conversation.input.dock` entry
 * that renders a collapsible investigation-tree panel above the composer —
 * structurally identical to todo_write's TodoPanel (same CSS class names,
 * same dock registration, same collapse pattern). Reads the `trace`
 * projection via useProjection.
 *
 * Bundled by esbuild into lib/client.js in the ModuleLoader lazy-CJS format.
 * React is an external (provided by the browser module table).
 *
 * @module @deepseek-ai/dsh-ops-trace/client
 */

import { createElement as h, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  IconChecklistOutline14,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ForestState, TreeState, TreeNode, NodeStatus } from './types.ts'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-trace-client'
const inject = ['slots']

// ── CSS (mirrors TodoPanel.module.css exactly) ──────────────────────────────

const CSS = `
/* Hide trace panel when the trajectory view tab is active (not the chat tab) */
[data-phase]:has([role="tab"][aria-selected="true"]:not(:first-of-type)) .ops-trace-root {
  display: none;
}

.ops-trace-root {
  box-sizing: border-box;
  flex: none;
  overflow: hidden;
  margin: 0 auto;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  max-width: calc(
    var(--dsh-composer-card-max-width) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  border-radius: 12px;
  background: var(--dsw-specific-tip, #f6f8fa);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2, #d0d7de);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2, #afb8c1);
}

.ops-trace-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 12px;
}

.ops-trace-header-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.ops-trace-switcher {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.ops-trace-switch-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #656d76);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  border-radius: 4px;
}

.ops-trace-switch-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-hover, #e9ecef);
  color: var(--dsw-alias-label-primary, #1f2328);
}

.ops-trace-switch-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.ops-trace-switch-pos {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #656d76);
  min-width: 28px;
  text-align: center;
}

.ops-trace-chevron-btn {
  display: grid;
  flex: none;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #656d76);
  cursor: pointer;
  border-radius: 4px;
}

.ops-trace-chevron-btn:hover {
  background: var(--dsw-alias-bg-hover, #e9ecef);
  color: var(--dsw-alias-label-primary, #1f2328);
}

.ops-trace-lead {
  display: grid;
  flex: none;
  place-items: center;
  color: var(--dsw-alias-label-tertiary, #656d76);
}

.ops-trace-progress {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary, #656d76);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ops-trace-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 300px;
  overflow-y: auto;
}

.ops-trace-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #656d76);
}

.ops-trace-item-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  cursor: pointer;
  border-radius: 4px;
  padding: 1px 4px;
}

.ops-trace-item-row:hover {
  background: var(--dsw-alias-bg-hover, #e9ecef);
}

.ops-trace-glyph {
  display: grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-top: 2px;
}

.ops-trace-text {
  flex: 1 1 auto;
  min-width: 0;
}

.ops-trace-node-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #1f2328);
}

.ops-trace-node-title-dead {
  text-decoration: line-through;
  color: var(--dsw-alias-label-tertiary, #848d97);
}

.ops-trace-node-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #848d97);
  margin-left: 4px;
}

.ops-trace-node-detail {
  padding: 2px 8px 4px 22px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #848d97);
}

.ops-trace-detail-value {
  min-width: 0;
  word-break: break-word;
  white-space: pre-wrap;
}

.ops-trace-caused-tag {
  display: inline-block;
  font-size: 11px;
  line-height: 16px;
  padding: 1px 6px;
  margin-right: 4px;
  border-radius: 8px;
  background: rgba(209,36,47,0.10);
  color: #d1242f;
  white-space: nowrap;
  vertical-align: 1px;
}

.ops-trace-glyph-done { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.ops-trace-glyph-pending { color: var(--dsw-alias-label-caption, #848d97); }
.ops-trace-glyph-progress { color: var(--dsw-alias-state-business-primary, #0969da); animation: ops-trace-spin 1s linear infinite; }
.ops-trace-glyph-deadend { color: #d1242f; }
.ops-trace-glyph-goal { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.ops-trace-glyph-resolved { color: var(--dsw-alias-state-success-primary, #1a7f37); }

@keyframes ops-trace-spin { to { transform: rotate(360deg); } }
`.trim()

let cssInjected = false
function injectCSS(): void {
  if (cssInjected || typeof document === 'undefined') return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'ops-trace'
  tag.textContent = CSS
  document.head.appendChild(tag)
  cssInjected = true
}

// ── Status glyphs (14x14, same as TodoPanel) ────────────────────────────────

function svgBase(children: any[], cls: string): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none',
    'aria-hidden': 'true', className: cls,
  }, children)
}

function DoneGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', {
      d: 'M10.96 5.71L7.70 8.98C7.48 9.20 7.28 9.40 7.09 9.55C6.90 9.71 6.66 9.85 6.36 9.90C6.20 9.93 6.04 9.93 5.88 9.90C5.59 9.85 5.35 9.71 5.16 9.55C4.97 9.40 4.77 9.20 4.55 8.98L3.04 7.46L3.96 6.54L5.47 8.05C5.72 8.29 5.86 8.43 5.98 8.53C6.09 8.61 6.11 8.61 6.09 8.60C6.11 8.61 6.14 8.61 6.16 8.60C6.14 8.61 6.16 8.61 6.27 8.53C6.39 8.43 6.53 8.29 6.77 8.05L10.04 4.79L10.96 5.71Z',
      fill: 'currentColor',
    }),
  ], 'ops-trace-glyph ops-trace-glyph-done')
}

function ProgressGlyph(nodeId: string): any {
  const gid = 'ops-g-' + nodeId
  return svgBase([
    h('defs', null,
      h('linearGradient', {
        id: gid, x1: 2.5, y1: 12, x2: 10.5, y2: 3.5, gradientUnits: 'userSpaceOnUse',
      },
        h('stop', { stopColor: 'currentColor' }),
        h('stop', { offset: 1, stopColor: 'currentColor', stopOpacity: 0 }),
      ),
    ),
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: `url(#${gid})`, strokeWidth: 1.2 }),
  ], 'ops-trace-glyph ops-trace-glyph-progress')
}

function PendingGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.2, strokeDasharray: '2.4 2.4' }),
  ], 'ops-trace-glyph ops-trace-glyph-pending')
}

function DeadEndGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M4.5 4.5 L9.5 9.5 M9.5 4.5 L4.5 9.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
  ], 'ops-trace-glyph ops-trace-glyph-deadend')
}

function GoalGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.6, strokeDasharray: '3 2' }),
  ], 'ops-trace-glyph ops-trace-glyph-goal')
}

function ResolvedGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.4, fill: 'currentColor', fillOpacity: 0.15 }),
    h('path', {
      d: 'M10.96 5.71L7.70 8.98C7.48 9.20 7.28 9.40 7.09 9.55C6.90 9.71 6.66 9.85 6.36 9.90C6.20 9.93 6.04 9.93 5.88 9.90C5.59 9.85 5.35 9.71 5.16 9.55C4.97 9.40 4.77 9.20 4.55 8.98L3.04 7.46L3.96 6.54L5.47 8.05C5.72 8.29 5.86 8.43 5.98 8.53C6.09 8.61 6.11 8.61 6.09 8.60C6.11 8.61 6.14 8.61 6.16 8.60C6.14 8.61 6.16 8.61 6.27 8.53C6.39 8.43 6.53 8.29 6.77 8.05L10.04 4.79L10.96 5.71Z',
      fill: 'currentColor',
    }),
  ], 'ops-trace-glyph ops-trace-glyph-resolved')
}

function StatusGlyph(status: NodeStatus, nodeId: string, hasInfo: boolean): any {
  switch (status) {
    case 'goal': return GoalGlyph()
    case 'done': return hasInfo ? ResolvedGlyph() : DoneGlyph()
    case 'in_progress': return ProgressGlyph(nodeId)
    case 'dead_end': return DeadEndGlyph()
    case 'resolved': return ResolvedGlyph()
    default: return PendingGlyph()
  }
}

// ── Progress label (mirrors TodoPanel.progressLabel) ─────────────────────────

function progressLabel(tree: TreeState): string {
  const counts: Partial<Record<NodeStatus, number>> = {}
  for (const n of tree.nodes) counts[n.status] = (counts[n.status] ?? 0) + 1
  const parts: string[] = [`${tree.nodes.length} nodes`]
  if (counts.done) parts.push(`${counts.done} done`)
  if (counts.in_progress) parts.push(`${counts.in_progress} active`)
  if (counts.pending) parts.push(`${counts.pending} pending`)
  if (counts.dead_end) parts.push(`${counts.dead_end} dead`)
  if (tree.resolved) parts.push('resolved')
  return parts.join('\u2002\u00b7\u2002')
}

// ── Tree layout ──────────────────────────────────────────────────────────────

function depthOf(nodes: TreeNode[], id: string, cache: Record<string, number> = {}): number {
  if (id in cache) return cache[id]
  const node = nodes.find(n => n.id === id)
  if (!node || node.parent === null) { cache[id] = 0; return 0 }
  const d = depthOf(nodes, node.parent, cache) + 1
  cache[id] = d
  return d
}

/** DFS traversal: children follow their parent, preserving insertion order. */
function treeOrder(nodes: TreeNode[]): TreeNode[] {
  const childrenOf: Record<string, TreeNode[]> = {}
  let root: TreeNode | undefined
  for (const n of nodes) {
    if (n.parent === null) { root = n; continue }
    const list = childrenOf[n.parent] ?? (childrenOf[n.parent] = [])
    list.push(n)
  }
  const result: TreeNode[] = []
  function visit(node: TreeNode): void {
    result.push(node)
    const kids = childrenOf[node.id]
    if (kids) for (const k of kids) visit(k)
  }
  if (root) visit(root)
  // Orphans (parent not found) appended at the end
  for (const n of nodes) {
    if (!result.includes(n)) result.push(n)
  }
  return result
}

function formatContent(node: TreeNode): string {
  let text = node.title
  if (node.caused_by.length > 0) text += `  \u2190 ${node.caused_by.join(', ')}`
  if (node.summary) text += `  \u2014 ${node.summary}`
  return text
}

/** Whether a node has expandable detail (caused_by or summary). */
function hasDetail(node: TreeNode): boolean {
  return node.caused_by.length > 0 || !!node.summary
}

/** One node row: clickable to expand summary if present. */
function TreeNodeItem({ node, depth, nodes }: { node: TreeNode, depth: number, nodes: TreeNode[] }): any {
  const [expanded, setExpanded] = useState(false)
  const titleClass = node.status === 'dead_end'
    ? 'ops-trace-node-title ops-trace-node-title-dead'
    : 'ops-trace-node-title'
  const expandable = !!node.summary

  return h('li', {
    key: node.id,
    className: 'ops-trace-item',
    'data-status': node.status,
    style: { paddingLeft: `${depth * 20}px` },
  },
    h('div', {
      className: 'ops-trace-item-row',
      role: expandable ? 'button' : undefined,
      tabIndex: expandable ? 0 : undefined,
      'aria-expanded': expandable ? expanded : undefined,
      onClick: expandable ? () => setExpanded(v => !v) : undefined,
      onKeyDown: expandable ? (e: any) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) }
      } : undefined,
    },
      h('span', { className: 'ops-trace-glyph', 'aria-hidden': 'true' },
        StatusGlyph(node.status, node.id, node.caused_by.length > 0 || !!node.summary),
      ),
      h('div', { className: 'ops-trace-text' },
        h('div', { className: titleClass }, node.title),
      ),
    ),
    expanded && expandable && h('div', { className: 'ops-trace-node-detail' },
      node.caused_by.length > 0 && h('span', {
        className: 'ops-trace-caused-tag',
        key: 'caused',
      }, '\u2190 ' + node.caused_by.join(', ')),
      node.summary,
    ),
  )
}

// ── Dock component ───────────────────────────────────────────────────────────

function TraceDock({ useProjection }: { useProjection?: (key: string) => unknown | undefined }): any {
  let forest: ForestState | null = null
  try {
    if (useProjection) {
      const val = useProjection('trace')
      forest = (val as ForestState | null | undefined) ?? null
    }
  } catch {
    forest = null
  }

  const [activeIndex, setActiveIndex] = useState(0)
  const [collapsed, setCollapsed] = useState(false)

  if (!forest || !forest.trees || forest.trees.length === 0) return null

  // Clamp activeIndex to valid range (trees may shrink/grow)
  const total = forest.trees.length
  const idx = Math.min(activeIndex, total - 1)
  const tree = forest.trees[idx]
  if (!tree || !tree.nodes || tree.nodes.length === 0) return null

  const cache: Record<string, number> = {}
  const sorted = treeOrder(tree.nodes)
  const hasMultiple = total > 1
  const isActiveResolved = tree.resolved

  // Header: icon + [‹ 1/2 ›] + progress + chevron
  return h('section', {
    className: 'ops-trace-root',
    'data-testid': 'ops-trace-panel',
    'aria-label': 'Trace',
  },
    h('div', { className: 'ops-trace-body' },
      h('div', { className: 'ops-trace-header-row' },
        h('span', { className: 'ops-trace-lead', 'aria-hidden': 'true' }, h(IconChecklistOutline14)),
        hasMultiple && h('span', { className: 'ops-trace-switcher' },
          h('button', {
            type: 'button',
            className: 'ops-trace-switch-btn',
            onClick: () => { setActiveIndex(Math.max(0, idx - 1)); setCollapsed(false) },
            disabled: idx === 0,
            'aria-label': 'Previous trace',
          }, '\u2039'),
          h('span', { className: 'ops-trace-switch-pos' }, `${idx + 1}/${total}`),
          h('button', {
            type: 'button',
            className: 'ops-trace-switch-btn',
            onClick: () => { setActiveIndex(Math.min(total - 1, idx + 1)); setCollapsed(false) },
            disabled: idx === total - 1,
            'aria-label': 'Next trace',
          }, '\u203a'),
        ),
        h('span', { className: 'ops-trace-progress' }, progressLabel(tree)),
        h('button', {
          type: 'button',
          className: 'ops-trace-chevron-btn',
          onClick: () => { setCollapsed(v => !v) },
          'aria-expanded': !collapsed,
          'aria-label': collapsed ? 'Expand' : 'Collapse',
        },
          collapsed ? h(IconChevronUpOutline14) : h(IconChevronDownOutline14),
        ),
      ),
      !collapsed && h('ul', { className: 'ops-trace-list' },
        sorted.map(node => {
          const depth = depthOf(tree.nodes, node.id, cache)
          return h(TreeNodeItem, { key: node.id, node, depth, nodes: tree.nodes })
        }),
      ),
    ),
  )
}

// ── Client plugin apply (mirrors todoDockEntry) ─────────────────────────────

function apply(ctx: Context): void {
  injectCSS()
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'ops-tree', order: 10 },
      TraceDock,
    ),
  )
}

export { apply, inject, name }
