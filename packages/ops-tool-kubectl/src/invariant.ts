/**
 * Invariant companion for @deepseek-ai/dsh-ops-kubectl.
 *
 * @module @deepseek-ai/dsh-ops-kubectl/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-ops-kubectl'

/** Cordis companion plugin name. */
const name = 'ops-kubectl-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this tool owns no session events and no durable
 * state. Each call resolves the profile and runs the command independently;
 * the result is plain tool output, folded by no projection.
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
