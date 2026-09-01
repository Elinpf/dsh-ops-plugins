/**
 * Invariant companion for @deepseek-ai/dsh-ops-trace-ui.
 *
 * @module @deepseek-ai/dsh-ops-trace-ui/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-ops-trace-ui'

/** Cordis companion plugin name. */
const name = 'ops-trace-ui-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this package owns no session event types and no
 * durable shape of its own. It re-registers the shared `trace` projection
 * verbatim from @deepseek-ai/dsh-ops-tool-trace (whose fold is pure and
 * idempotent, validated tool-side before events reach the log) and carries
 * the web panel client bundle — the panel only reads projection snapshots
 * and holds ephemeral UI state.
 */
const install = (): void => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Context carrying the invariant service.
 * @returns a promise resolving after registration.
 */
const apply = async (ctx: any): Promise<void> => {
  ctx.invariants.register(PACKAGE_NAME, install)
}

export { apply, inject, name }
