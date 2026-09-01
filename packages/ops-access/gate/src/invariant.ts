/**
 * Invariant companion for @deepseek-ai/dsh-ops-access-gate.
 *
 * @module @deepseek-ai/dsh-ops-access-gate/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-ops-access-gate'

/** Cordis companion plugin name. */
const name = 'ops-access-gate-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: the gate owns no session-event shape. Its state is
 * an in-process grant ledger plus an append-only JSONL audit file (and the
 * persisted lockdown set), all outside the session log — there is no fold
 * to validate, and every authorization decision is a pure function of the
 * ledger at resolve time.
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
