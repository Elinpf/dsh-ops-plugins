/**
 * Client half for ops-todo-tree: registers a `tool.call.toolview` keyed row
 * for the `todo_tree` tool, following the same pattern as `todo_write`'s
 * TodoRow — a one-line summary row that expands to show the tool's text output.
 *
 * Uses DisclosureRow + StateDot from ui-primitives (public API) rather than
 * the internal ToolRow component, keeping the external bundle self-contained.
 *
 * Bundled by esbuild into lib/client.js in the ModuleLoader lazy-CJS format.
 * React is an external (provided by the browser module table).
 *
 * @module @deepseek-ai/dsh-ops-todo-tree/client
 */

import { createElement as h, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import {
  DisclosureRow,
  StateDot,
  IconChecklistOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-todo-tree-client'
const inject = ['slots']

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of a settled ToolResultNode that we read. */
interface SettledBlock {
  kind: 'tool-result'
  call: { name: string, argsRaw: string } | null
  content: readonly { type: string, text?: string }[]
  isError: boolean
}

/** Minimal shape of a RunningToolCall that we read. */
interface RunningBlock {
  name: string
  argsRaw: string
}

type Block = SettledBlock | RunningBlock

// ── Summary derivation ───────────────────────────────────────────────────────

function parseArgs(argsRaw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsRaw)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    // Mid-stream truncation or malformed model JSON
  }
  return null
}

function formatIds(args: Record<string, unknown>): string {
  if (Array.isArray(args.ids)) return (args.ids as string[]).join(', ')
  if (typeof args.id === 'string') return args.id
  return ''
}

function formatLinkSummary(args: Record<string, unknown>): string {
  if (Array.isArray(args.links)) {
    const pairs = (args.links as Array<{ id: string, caused_by: string }>)
      .map(l => `${l.id}←${l.caused_by}`)
    return `link: ${pairs.join(', ')}`
  }
  const id = args.id as string | undefined
  const causedBy = args.caused_by as string | undefined
  return `link: ${id ?? ''}←${causedBy ?? ''}`
}

/** Derive a one-line summary from the todo_tree call args. */
function summarize(argsRaw: string): string {
  const args = parseArgs(argsRaw)
  if (!args) return argsRaw || 'todo_tree'
  const action = args.action as string | undefined
  if (!action) return 'todo_tree'
  switch (action) {
    case 'create_tree': return `Create: ${args.goal_title ?? ''}`
    case 'add_milestone': return `+ milestone: ${args.id ?? ''}`
    case 'add_step': return `+ step: ${args.id ?? ''}`
    case 'start': return `start: ${formatIds(args)}`
    case 'complete': return `complete: ${formatIds(args)}`
    case 'abandon': return `abandon: ${formatIds(args)}`
    case 'reopen': return `reopen: ${formatIds(args)}`
    case 'resolve': return 'resolve goal'
    case 'link': return formatLinkSummary(args)
    case 'view': return 'view tree'
    default: return action
  }
}

/** Extract the result text from a settled block's content. */
function resultText(block: SettledBlock): string | null {
  const parts: string[] = []
  for (const b of block.content) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

// ── Row component ────────────────────────────────────────────────────────────

type TodoTreeRowProps = ToolCallViewProps & { t: TranslateNS<'conversation'> }

function TodoTreeRow({ toolName, block, t }: TodoTreeRowProps) {
  const isSettled = typeof block === 'object' && block !== null && 'kind' in block
  const settled = isSettled ? block as SettledBlock : null
  const running = !isSettled ? block as RunningBlock : null

  const argsRaw = (settled?.call?.argsRaw ?? running?.argsRaw) ?? ''
  const summary = summarize(argsRaw)

  const output = settled ? resultText(settled) : null
  const isError = settled?.isError ?? false

  const dotState = !isSettled ? 'ongoing' : isError ? 'error' : 'done'
  const expandable = output !== null

  const [open, setOpen] = useState(false)

  return h(DisclosureRow, {
    icon: h(StateDot, { state: dotState }),
    title: 'Todo Tree',
    open: open && expandable,
    expandable,
    onToggle: () => setOpen(v => !v),
    expandOnRowClick: true,
    keepContentWhenOpen: true,
    collapsedContent: summary,
  },
    output ? h('pre', {
      style: {
        margin: '4px 0 0',
        padding: '8px 12px',
        fontSize: '13px',
        lineHeight: '1.5',
        fontFamily: 'ui-monospace, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: isError ? '#d1242f' : '#1f2328',
        background: '#f6f8fa',
        borderRadius: '6px',
        maxHeight: '400px',
        overflow: 'auto',
      },
    }, output) : null,
  )
}

// ── Client plugin apply ─────────────────────────────────────────────────────

function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key: 'todo_tree' },
      TodoTreeRow,
    ),
  )
}

export { apply, inject, name }
