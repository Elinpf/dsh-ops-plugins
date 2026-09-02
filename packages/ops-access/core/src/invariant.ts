/**
 * Invariant companion for @elinpf/dsh-ops-access.
 *
 * @module @elinpf/dsh-ops-access/invariant
 */

const PACKAGE_NAME = '@elinpf/dsh-ops-access'

/** Cordis companion plugin name. */
const name = 'ops-access-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this package owns no session event types and no
 * projection — its durable state is the YAML registry file, which is
 * re-read, re-parsed, and re-validated on EVERY call (no cache to drift),
 * and writes are validated against the provider schema before they land.
 * The in-memory state (provider/broker registrations) is fiber-scoped and
 * torn down by effect disposal, so there is nothing to guard at runtime.
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
