/**
 * Client half for ops-todo-tree: registers the "调查树" tab in conversation.view.
 *
 * Bundled by esbuild into lib/client.js in the ModuleLoader lazy-CJS format.
 * React is an external (provided by the browser module table).
 *
 * @module @deepseek-ai/dsh-ops-todo-tree/client
 */

import { createElement as h, useState } from 'react'
import type { TreeState, TreeNode, NodeStatus } from './types.ts'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-todo-tree-client'
const inject = ['slots', 'sessions', 'locale']

// ── CSS (self-injected via <style> tag) ─────────────────────────────────────

const CSS = [
  '.ops-root{position:relative;height:100%;display:flex;flex-direction:column;background:#fff;color:#1f2328;font-family:system-ui,sans-serif;overflow:hidden}',
  '.ops-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#848d97;font-size:14px}',
  '.ops-list-wrap{flex:1;overflow:auto;position:relative}',
  '.ops-graph-svg{position:absolute;top:0;left:0;pointer-events:none;z-index:1}',
  '.ops-list{position:relative;z-index:0}',
  '.ops-row{display:flex;align-items:center;border-bottom:1px solid #e5e7eb;cursor:default;transition:background .15s;box-sizing:border-box;position:relative}',
  '.ops-row-hover{background:#ddf4ff}',
  '.ops-row-dot-wrap{flex:none;position:relative;height:100%}',
  '.ops-dot-pos{position:absolute}',
  '.ops-dot-pos svg{display:block}',
  '.ops-row-content{flex:1;display:flex;align-items:center;gap:8px;padding-right:12px;min-width:0;flex-wrap:wrap}',
  '.ops-row-title{font-size:14px;color:#1f2328;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.ops-row-dead{text-decoration:line-through;color:#656d76}',
  '.ops-row-bold{font-weight:600}',
  '.ops-pill{font-size:11px;padding:2px 8px;border-radius:12px;color:#fff;flex:none;white-space:nowrap}',
  '.ops-pill-blue{background:#0969da}',
  '.ops-pill-purple{background:#8250df}',
  '.ops-expand{font-size:10px;color:#848d97;flex:none;cursor:pointer}',
  '.ops-sub-row{width:100%;font-size:12px;color:#656d76;margin-top:2px}',
  '.ops-glyph-root{color:#d97706}',
  '.ops-glyph-goal{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
  '.ops-glyph-done{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
  '.ops-glyph-progress{color:var(--dsw-alias-state-business-primary,#0969da);animation:1s linear infinite ops-spin}',
  '.ops-glyph-pending{color:var(--dsw-alias-label-caption,#848d97)}',
  '.ops-glyph-deadend{color:#d1242f}',
  '.ops-glyph-resolved{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
  '@keyframes ops-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
].join('\n')

let cssInjected = false
function injectCSS(): void {
  if (cssInjected || typeof document === 'undefined') return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'ops-todo-tree'
  tag.textContent = CSS
  document.head.appendChild(tag)
  cssInjected = true
}

// ── Glyphs (SVG, 14x14, semantic colors) ────────────────────────────────────

function svgBase(children: any[], cls: string): any {
  return h('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none',
    'aria-hidden': 'true', className: cls,
  }, children)
}

function RootGlyph(): any {
  return svgBase([h('circle', { cx: 7, cy: 7, r: 5.5, fill: 'currentColor' })], 'ops-glyph ops-glyph-root')
}

function GoalGlyph(): any {
  return svgBase([h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.6, strokeDasharray: '3 2' })], 'ops-glyph ops-glyph-goal')
}

function PendingGlyph(): any {
  return svgBase([h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.2, strokeDasharray: '2.4 2.4' })], 'ops-glyph ops-glyph-pending')
}

function DoneGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', {
      d: 'M10.96 5.71L7.70 8.98C7.48 9.20 7.28 9.40 7.09 9.55C6.90 9.71 6.66 9.85 6.36 9.90C6.20 9.93 6.04 9.93 5.88 9.90C5.59 9.85 5.35 9.71 5.16 9.55C4.97 9.40 4.77 9.20 4.55 8.98L3.04 7.46L3.96 6.54L5.47 8.05C5.72 8.29 5.86 8.43 5.98 8.53C6.09 8.61 6.11 8.61 6.09 8.60C6.11 8.61 6.14 8.61 6.16 8.60C6.14 8.61 6.16 8.61 6.27 8.53C6.39 8.43 6.53 8.29 6.77 8.05L10.04 4.79L10.96 5.71Z',
      fill: 'currentColor',
    }),
  ], 'ops-glyph ops-glyph-done')
}

function DeadEndGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M4.5 4.5 L9.5 9.5 M9.5 4.5 L4.5 9.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
  ], 'ops-glyph ops-glyph-deadend')
}

function ResolvedGlyph(): any {
  return svgBase([
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: 'currentColor', strokeWidth: 1.4, fill: 'currentColor', fillOpacity: 0.15 }),
    h('path', {
      d: 'M10.96 5.71L7.70 8.98C7.48 9.20 7.28 9.40 7.09 9.55C6.90 9.71 6.66 9.85 6.36 9.90C6.20 9.93 6.04 9.93 5.88 9.90C5.59 9.85 5.35 9.71 5.16 9.55C4.97 9.40 4.77 9.20 4.55 8.98L3.04 7.46L3.96 6.54L5.47 8.05C5.72 8.29 5.86 8.43 5.98 8.53C6.09 8.61 6.11 8.61 6.09 8.60C6.11 8.61 6.14 8.61 6.16 8.60C6.14 8.61 6.16 8.61 6.27 8.53C6.39 8.43 6.53 8.29 6.77 8.05L10.04 4.79L10.96 5.71Z',
      fill: 'currentColor',
    }),
  ], 'ops-glyph ops-glyph-resolved')
}

function InProgressGlyph(nodeId: string): any {
  const gid = 'ops-g-' + nodeId
  return svgBase([
    h('defs', null,
      h('linearGradient', {
        id: gid, x1: 2.5, y1: 12, x2: 10.5, y2: 3.5, gradientUnits: 'userSpaceOnUse',
      },
        h('stop', { stopColor: 'currentColor' }),
        h('stop', { offset: 1, stopColor: 'currentColor', stopOpacity: 0 }),
      )
    ),
    h('circle', { cx: 7, cy: 7, r: 6.4, stroke: `url(#${gid})`, strokeWidth: 1.2 }),
  ], 'ops-glyph ops-glyph-progress')
}

function Glyph(status: NodeStatus, isRoot: boolean, nodeId: string): any {
  if (isRoot) return RootGlyph()
  switch (status) {
    case 'goal': return GoalGlyph()
    case 'done': return DoneGlyph()
    case 'in_progress': return InProgressGlyph(nodeId)
    case 'dead_end': return DeadEndGlyph()
    case 'resolved': return ResolvedGlyph()
    default: return PendingGlyph()
  }
}

// ── Layout constants ─────────────────────────────────────────────────────────

const LANE_W = 24
const ROW_H = 32
const GRAPH_W = 60
const LEFT_PAD = 10
const TOP_PAD = 4

const BRANCH_COLORS = ['#8957e5', '#1f6feb', '#d1242f', '#bf3989', '#0969da', '#8250df', '#1a7f37']

function laneColor(lane: number): string {
  return lane === 0 ? '#8957e5' : BRANCH_COLORS[lane % BRANCH_COLORS.length]
}

function laneX(lane: number): number {
  return LEFT_PAD + lane * LANE_W
}

// ── Lane/depth computation (client-side, 09) ────────────────────────────────

interface PositionedNode extends TreeNode {
  _lane: number
  _depth: number
  _branch: boolean
}

function computeLayout(nodes: TreeNode[]): PositionedNode[] {
  const byId: Record<string, PositionedNode> = {}
  for (const n of nodes) {
    byId[n.id] = { ...n, _lane: 0, _depth: 0, _branch: false } as PositionedNode
  }

  const depthCache: Record<string, number> = {}
  function getDepth(id: string): number {
    if (id in depthCache) return depthCache[id]
    const node = byId[id]
    if (!node || node.parent === null) { depthCache[id] = 0; return 0 }
    const d = getDepth(node.parent) + 1
    depthCache[id] = d
    return d
  }

  const sorted = [...nodes].sort((a, b) => getDepth(a.id) - getDepth(b.id))
  let maxLane = 0

  const childLanes: Record<string, number | null> = {}

  for (const n of sorted) {
    const pn = byId[n.id]
    pn._depth = getDepth(n.id)
    if (n.parent === null) {
      pn._lane = 0
      pn._branch = false
    } else {
      const parentLane = byId[n.parent]?._lane ?? 0
      if (childLanes[n.parent] === null || childLanes[n.parent] === undefined) {
        pn._lane = parentLane
        pn._branch = false
        childLanes[n.parent] = parentLane
      } else {
        maxLane++
        pn._lane = maxLane
        pn._branch = true
      }
    }
    if (pn._lane > maxLane) maxLane = pn._lane
  }

  return sorted.map((n) => byId[n.id])
}

// ── View component ──────────────────────────────────────────────────────────

function OpsTreeView(props: any): any {
  const tree: TreeState | null = props.useProjection ? props.useProjection('todo_tree') : null

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [hovered, setHovered] = useState<string | null>(null)

  if (!tree || !tree.nodes || tree.nodes.length === 0) {
    return h('div', { className: 'ops-root' },
      h('div', { className: 'ops-empty' }, '尚无调查树 — agent 创建后这里会显示')
    )
  }

  const positioned = computeLayout(tree.nodes)
  const maxLane = positioned.reduce((mx, n) => Math.max(mx, n._lane), 0)
  const graphW = GRAPH_W + maxLane * LANE_W

  const yPos: Record<string, number> = {}
  let y = TOP_PAD
  for (const n of positioned) {
    yPos[n.id] = y
    let rh = ROW_H
    if (expanded[n.id]) {
      rh = ROW_H + (n.detail ? 18 : 0) + (n.summary ? 18 : 0) + 4
    }
    y += rh
  }
  const svgH = y + 4

  const laneLines: any[] = []
  for (let l = 0; l <= maxLane; l++) {
    const lx = laneX(l)
    const laneNodes = positioned.filter((n) => n._lane === l)
    for (let i = 0; i < laneNodes.length - 1; i++) {
      const n1 = laneNodes[i], n2 = laneNodes[i + 1]
      const y1 = yPos[n1.id] + 7, y2 = yPos[n2.id] + 7
      const executed = ['done', 'in_progress', 'dead_end', 'resolved'].includes(n1.status)
        || ['done', 'in_progress', 'dead_end', 'resolved'].includes(n2.status)
      laneLines.push(h('line', {
        key: `lane${l}-${i}`, x1: lx, y1: y1, x2: lx, y2: y2,
        stroke: laneColor(l), strokeWidth: 2.5, opacity: 0.7,
        strokeDasharray: executed ? undefined : '2.4 2.4',
      }))
    }
  }

  const conn: any[] = []
  for (const n of positioned) {
    if (n.parent === null) continue
    const parent = positioned.find((p) => p.id === n.parent)
    if (!parent) continue
    if (n._lane === parent._lane) continue

    const fx = laneX(parent._lane), fy = yPos[parent.id] + 7
    const tx = laneX(n._lane), ty = yPos[n.id] + 7
    const r = 6
    const executed = ['done', 'in_progress', 'dead_end', 'resolved'].includes(n.status)
    conn.push(h('path', {
      key: `conn-${n.id}`,
      d: `M ${fx} ${fy} L ${tx - r} ${fy} Q ${tx} ${fy} ${tx} ${fy + r} L ${tx} ${ty - 7}`,
      stroke: laneColor(n._lane), strokeWidth: 2, fill: 'none', opacity: 0.7,
      strokeDasharray: executed ? undefined : '2.4 2.4',
    }))
  }

  const rows = positioned.map((n) => {
    const nx = laneX(n._lane), ny = yPos[n.id]
    const isRoot = n.parent === null
    const isDead = n.status === 'dead_end'
    const isResolved = n.status === 'resolved'
    const isExp = expanded[n.id]
    const canExpand = !!(n.detail || n.summary)
    const isHover = hovered === n.id

    const contentChildren: any[] = []
    contentChildren.push(h('span', {
      key: 't',
      className: 'ops-row-title' + (isDead ? ' ops-row-dead' : '') + (isResolved ? ' ops-row-bold' : ''),
    }, n.title))

    if (n.turns && n.turns.length) {
      contentChildren.push(h('span', {
        key: 'tb',
        className: 'ops-pill ' + (n._lane === 0 ? 'ops-pill-blue' : 'ops-pill-purple'),
      }, 'T' + n.turns.join(',')))
    }
    if (canExpand) {
      contentChildren.push(h('span', {
        key: 'exp', className: 'ops-expand',
      }, isExp ? '▼' : '▶'))
    }
    if (isExp) {
      if (n.detail) contentChildren.push(h('div', { key: 'det', className: 'ops-sub-row' }, n.detail))
      if (n.summary) contentChildren.push(h('div', { key: 'sum', className: 'ops-sub-row' }, '结论：' + n.summary))
    }

    let rowH = ROW_H
    if (expanded[n.id]) {
      rowH = ROW_H + (n.detail ? 18 : 0) + (n.summary ? 18 : 0) + 4
    }

    return h('div', {
      key: 'r-' + n.id,
      className: 'ops-row' + (isHover ? ' ops-row-hover' : ''),
      style: { height: rowH + 'px' },
      onMouseEnter: () => setHovered(n.id),
      onMouseLeave: () => setHovered(null),
      onClick: canExpand ? () => {
        setExpanded((prev: Record<string, boolean>) => {
          const next = { ...prev }
          if (next[n.id]) delete next[n.id]
          else next[n.id] = true
          return next
        })
      } : undefined,
    },
      h('div', {
        key: 'dot', className: 'ops-row-dot-wrap', style: { width: graphW + 'px' },
      },
        h('div', {
          key: 'd', className: 'ops-dot-pos',
          style: { left: (nx - 7) + 'px', top: '50%', transform: 'translateY(-50%)' },
        }, Glyph(n.status, isRoot, n.id)),
      ),
      h('div', { key: 'c', className: 'ops-row-content' }, contentChildren),
    )
  })

  return h('div', { className: 'ops-root' },
    h('div', { className: 'ops-list-wrap' },
      h('svg', { key: 'svg', className: 'ops-graph-svg', width: graphW, height: svgH },
        ...laneLines, ...conn,
      ),
      h('div', { className: 'ops-list' }, ...rows),
    ),
  )
}

// ── Client plugin apply ─────────────────────────────────────────────────────

function apply(ctx: any): void {
  injectCSS()

  ctx.slots.inject('conversation.view', () => {
    ctx.slots.register(
      { name: 'conversation.view', id: 'ops-tree', order: 20, label: '调查树' },
      OpsTreeView,
    )
  })
}

export { apply, inject, name }
