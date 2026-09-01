/**
 * Invariant companion for @deepseek-ai/dsh-ops-prompts.
 *
 * @module @deepseek-ai/dsh-ops-prompts/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-ops-prompts'

/** Cordis companion plugin name. */
const name = 'ops-prompts-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no session event types and no
 * durable state. Methodology entries and reminder rules are ephemeral
 * registrations held in fiber-local maps, and reminder delivery goes through
 * agent.inject, which the session inbox splice already logs (model-visible
 * ⟺ logged holds without a package-owned fold).
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
