/**
 * Ops panel seam, browser half (ADR-0004). Provides ctx.opsPanels: a panel
 * registry keyed by slash-command name, ONE command/executed listener that
 * opens the matching panel in the browser that ran the command, imperative
 * open/close for ambient affordances (ADR-0004 §9), and the overlay shell
 * (header bar + Escape/backdrop dismissal) registered into
 * conversation.input.overlay. Panel content and data are the consumer's;
 * the shell owns only chrome and open state.
 *
 * Service, not library: bundled per consumer would mean N registries, N
 * listeners, and N shells colliding (the dual-module-instance lesson).
 *
 * @module @elinpf/dsh-ops-panel/client
 */

import { createElement as h, useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { OpsPanels, PanelDefinition } from './types.ts'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-panel-client'

const inject = ['slots']

// ── Core (React-free; unit-tested directly) ──────────────────────────────────

/**
 * The registry + open-state machine behind the service and the shell.
 * Open state is an immutable Map snapshot (sessionId -> command) so React
 * can subscribe with useSyncExternalStore.
 */
export interface PanelCore {
  registerPanel(def: PanelDefinition): () => void
  get(command: string): PanelDefinition | undefined
  subscribe(fn: () => void): () => void
  getSnapshot(): ReadonlyMap<string, string>
  open(sessionId: string, command: string): boolean
  close(sessionId: string): void
  handleCommandExecuted(sessionId: string, commandName: string): void
}

/** Create the panel registry and open-state store. */
export function createPanelCore(): PanelCore {
  const registry = new Map<string, PanelDefinition>()
  const listeners = new Set<() => void>()
  let snapshot: ReadonlyMap<string, string> = new Map()

  function emit(): void {
    for (const fn of listeners) fn()
  }

  function open(sessionId: string, command: string): boolean {
    const def = registry.get(command)
    if (!def) return false
    if (def.available && !def.available(sessionId)) return false
    const next = new Map(snapshot)
    next.set(sessionId, command)
    snapshot = next
    emit()
    return true
  }

  return {
    registerPanel(def) {
      if (registry.has(def.command)) {
        throw new Error('ops-panel: a panel is already registered for command ' + def.command)
      }
      registry.set(def.command, def)
      return () => { registry.delete(def.command) }
    },
    get(command) {
      return registry.get(command)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    getSnapshot() {
      return snapshot
    },
    open,
    close(sessionId) {
      if (!snapshot.has(sessionId)) return
      const next = new Map(snapshot)
      next.delete(sessionId)
      snapshot = next
      emit()
    },
    handleCommandExecuted(sessionId, commandName) {
      // Only registered panel commands open a panel; every other host
      // command (/plan, /compact, ...) passes through untouched.
      open(sessionId, commandName)
    },
  }
}

// ── CSS ──────────────────────────────────────────────────────────────────────

const CSS = [
  '.ops-panel-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); }',
  '.ops-panel-card { box-sizing: border-box; width: min(560px, calc(100vw - 48px)); max-height: min(70vh, 640px); display: flex; flex-direction: column; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-primary, #ffffff); color: var(--dsw-alias-text-primary, #1f2328); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18); overflow: hidden; }',
  '.ops-panel-header { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; font-size: 14px; font-weight: 600; border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb); }',
  '.ops-panel-close { border: none; background: transparent; color: inherit; font-size: 16px; line-height: 1; padding: 4px 8px; cursor: pointer; border-radius: 6px; opacity: 0.6; }',
  '.ops-panel-close:hover { opacity: 1; background: var(--dsw-alias-bg-secondary, #f6f8fa); }',
  '.ops-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px; font-size: 13px; }',
].join('\n')

let cssInjected = false
/** Inject the shell stylesheet once per page. */
function injectCSS(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const el = document.createElement('style')
  el.setAttribute('data-ops-panel', '')
  el.textContent = CSS
  document.head.appendChild(el)
}

// ── Shell view ───────────────────────────────────────────────────────────────

/**
 * The framework session-kit prop this shell reads. Session-scope slot
 * entries receive the SessionStandardProps merge (sessionId + useSession)
 * from the renderer — the overlay owner declares no owner props, so there
 * is no { session } object here (that shape belongs to owner-propped slots
 * like conversation.input.dock).
 */
interface ShellProps {
  sessionId?: string
}

/**
 * The overlay entry: renders the open panel of THIS session, null otherwise.
 * The overlay slot stays mounted for every session; the open-state store
 * decides visibility.
 */
/** @internal — exported for the jsdom render spec. */
export function ShellView({ sessionId }: ShellProps, core: PanelCore) {
  const openMap = useSyncExternalStore(core.subscribe, core.getSnapshot)
  const sid = sessionId
  const command = sid ? openMap.get(sid) : undefined
  const def = command ? core.get(command) : undefined
  const open = Boolean(sid && def)

  useEffect(() => {
    if (!open || !sid) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') core.close(sid)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, sid])

  if (!open || !sid || !def) return null
  const close = () => core.close(sid)
  return h('div', { className: 'ops-panel-backdrop', onClick: close },
    h('div', { className: 'ops-panel-card', onClick: (e: { stopPropagation(): void }) => e.stopPropagation() },
      h('div', { className: 'ops-panel-header' },
        h('span', null, def.title),
        h('button', { className: 'ops-panel-close', onClick: close, 'aria-label': '关闭' }, '×'),
      ),
      h('div', { className: 'ops-panel-body' }, h(def.component, { sessionId: sid, close })),
    ),
  )
}

// ── Client plugin apply ──────────────────────────────────────────────────────

/** The structural slice of the slots service this plugin needs. */
interface SlotsService {
  inject(slot: string, factory: () => unknown): () => void
  register(opts: Record<string, unknown>, component: unknown): () => void
}

function apply(ctx: Context): void {
  injectCSS()
  const core = createPanelCore()
  const service: OpsPanels = {
    registerPanel: (def) => core.registerPanel(def),
    // The imperative open path (ADR-0004 §9): ambient affordances like the
    // access-request badge pull the panel up without a typed command.
    open: (sessionId, command) => core.open(sessionId, command),
    close: (sessionId) => core.close(sessionId),
  }
  ctx.provide('opsPanels', service)

  // One dispatcher for every panel: the local command/executed event fires
  // only in the browser that submitted the command (the sanctioned
  // browser-only side-effect channel).
  const events = ctx as unknown as {
    on(event: string, cb: (sessionId: unknown, name: string, result: unknown) => void): void
  }
  events.on('command/executed', (sessionId, commandName) => {
    core.handleCommandExecuted(String(sessionId), commandName)
  })

  const slots = ctx.get('slots') as SlotsService | undefined
  if (slots !== undefined) {
    ctx.effect(() =>
      slots.inject('conversation.input.overlay', () =>
        slots.register(
          { name: 'conversation.input.overlay', id: 'ops-panel', order: 5 },
          (props: ShellProps) => ShellView(props, core),
        ),
      ),
    )
  }
}

export { apply, inject, name }
