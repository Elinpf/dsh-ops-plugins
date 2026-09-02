/**
 * Invariant companion for @elinpf/dsh-ops-shell-tool.
 *
 * @module @elinpf/dsh-ops-shell-tool/invariant
 */

const PACKAGE_NAME = '@elinpf/dsh-ops-shell-tool'

/** Cordis companion plugin name. */
const name = 'ops-shell-tool-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this package is a pure library — it appends no
 * session events and owns no durable shape. Its only state is per-call
 * credential tokens, created and dropped inside a single execute.
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
