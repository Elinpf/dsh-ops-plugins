/**
 * Invariant companion for @elinpf/dsh-ops-tool-prometheus.
 *
 * @module @elinpf/dsh-ops-tool-prometheus/invariant
 */

const PACKAGE_NAME = '@elinpf/dsh-ops-tool-prometheus'

/** Cordis companion plugin name. */
const name = 'ops-prometheus-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this tool is stateless. It owns no session events and
 * no durable shape — every call re-resolves the credential profile through
 * the ops-access seam and runs one HTTP query, so there is nothing to fold
 * and nothing to check.
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
