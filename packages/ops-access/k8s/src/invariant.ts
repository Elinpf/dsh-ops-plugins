/**
 * Invariant companion for @elinpf/dsh-ops-access-k8s.
 *
 * @module @elinpf/dsh-ops-access-k8s/invariant
 */

const PACKAGE_NAME = '@elinpf/dsh-ops-access-k8s'

/** Cordis companion plugin name. */
const name = 'ops-access-k8s-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this provider owns no session event types and no
 * durable shape of its own. It contributes one credential-kind validator
 * (schema + field processing + save-time probe) to the ops-access registry;
 * the registry file on disk is owned — and re-validated on every resolve —
 * by @elinpf/dsh-ops-access.
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
