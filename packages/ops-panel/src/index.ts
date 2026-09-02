/**
 * Ops panel seam, node half (ADR-0004). The plugin row itself is an empty
 * shell whose only job is client-bundle discovery (same pattern as
 * ops-access-ui). The node-side value is the registerPanelCommand helper:
 * a panel trigger is a host slash command whose handler is a deliberate
 * no-op — the lifecycle pair (command/run, command/done) is the durable,
 * log-only record, and the command/executed local browser event is what
 * opens the panel on the client half.
 *
 * @module @elinpf/dsh-ops-panel
 */

import z from '@deepseek-ai/schemastery'
import type { PanelCommandSpec } from './types.ts'

export type { OpsPanels, PanelCommandSpec, PanelComponent, PanelContentProps, PanelDefinition } from './types.ts'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-panel'

export const inject: string[] = []

// ── Config ───────────────────────────────────────────────────────────────────

/** No options: the row is a discovery-only shell, the helper takes its spec per call. */
export const Config = z.object({})

/** Empty by design: the row exists so the web resolver finds lib/client.js. */
export function apply(_ctx: never): void {}

// ── registerPanelCommand ─────────────────────────────────────────────────────

/** Slash command names parse as lowercase letters, digits, underscore, dash. */
const COMMAND_NAME = /^[a-z0-9_-]+$/

/**
 * The structural host this helper needs — deliberately NOT cordis's Context:
 * consumers link their own cordis instance (pnpm hoisting yields two type
 * graphs for the same version), and a structural parameter sidesteps the
 * dual-instance type clash. Any cordis context satisfies this.
 */
export interface PanelCommandHost {
  get(name: string): unknown
  effect(fn: () => () => void): unknown
}

/** The structural slice of the dsh-commands registry this helper needs. */
interface CommandRegistry {
  register(definition: {
    name: string
    description: string
    handler: () => { kind: string; text?: string }
  }): () => void
}

/**
 * Register the slash command that triggers a panel. The handler is a no-op
 * success: all behavior lives on the client half, dispatched from the local
 * command/executed event. The command registers agent-scoped when the caller
 * sits under agent.ctx (preset plane), so a panel command only exists in the
 * presets that mount the calling plugin.
 *
 * Misconfiguration fails loud at load: an invalid name or a missing commands
 * service throws instead of silently registering nothing.
 *
 * @param ctx - the calling plugin context (preset plane scopes the command).
 * @param spec - command name and menu description.
 */
export function registerPanelCommand(ctx: PanelCommandHost, spec: PanelCommandSpec): void {
  if (!COMMAND_NAME.test(spec.name)) {
    throw new Error('ops-panel: invalid panel command name ' + JSON.stringify(spec.name) + ' (lowercase letters, digits, underscore, dash only)')
  }
  const commands = ctx.get('commands') as CommandRegistry | undefined
  if (!commands) {
    throw new Error('ops-panel: the commands service is not composed — panel command ' + spec.name + ' cannot be registered in this deployment')
  }
  ctx.effect(() => commands.register({
    name: spec.name,
    description: spec.description,
    handler: () => ({ kind: 'success', text: 'Opening panel: ' + spec.name })
  }))
}
