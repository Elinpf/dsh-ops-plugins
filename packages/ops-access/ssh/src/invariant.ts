/**
 * Invariant companion for @elinpf/dsh-ops-access-ssh.
 *
 * @module @elinpf/dsh-ops-access-ssh/invariant
 */

const PACKAGE_NAME = '@elinpf/dsh-ops-access-ssh'

/** Cordis companion plugin name. */
const name = 'ops-access-ssh-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this provider owns no session events and no durable
 * shape of its own — it only contributes a zod schema plus field processing
 * to the ops-access registry, and entry validation happens at save time in
 * core (schema parse + validateContent), before anything is persisted.
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
