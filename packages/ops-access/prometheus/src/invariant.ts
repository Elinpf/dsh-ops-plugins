/**
 * Invariant companion for @elinpf/dsh-ops-access-prometheus.
 *
 * @module @elinpf/dsh-ops-access-prometheus/invariant
 */

const PACKAGE_NAME = '@elinpf/dsh-ops-access-prometheus'

/** Cordis companion plugin name. */
const name = 'ops-access-prometheus-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this provider owns no session events and no durable
 * shape of its own — it only validates and processes registry fields owned
 * by ops-access core. Content validation is a pure paste guard.
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
