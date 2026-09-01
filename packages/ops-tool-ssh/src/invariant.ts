/**
 * Invariant companion for @deepseek-ai/dsh-ops-tool-ssh.
 *
 * @module @deepseek-ai/dsh-ops-tool-ssh/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-ops-tool-ssh'

/** Cordis companion plugin name. */
const name = 'ops-tool-ssh-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this tool is fully stateless — it owns no session
 * event types and no durable shape. Every call resolves its profile fresh
 * through the ops-access seam and delegates execution to ctx.shell; there is
 * nothing folded from the log and nothing cached to keep consistent.
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
