/**
 * Invariant companion for @deepseek-ai/dsh-ops-access-ui.
 *
 * @module @deepseek-ai/dsh-ops-access-ui/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-ops-access-ui'

/** Cordis companion plugin name. */
const name = 'ops-access-ui-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session events and owns no
 * durable state — it is a pure browser-half carrier. All credential and
 * grant state lives in the ops-access core package (whose gate owns the
 * relevant invariants); the surfaces here only render route data, and the
 * host row is empty by design (client-bundle discovery only).
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
