/**
 * Invariant companion for @deepseek-ai/dsh-ops-todo-tree.
 *
 * @module @deepseek-ai/dsh-ops-todo-tree/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-ops-todo-tree'

/** Cordis companion plugin name. */
const name = 'ops-todo-tree-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * No runtime invariant: this tool owns no independent durable shape beyond
 * the session events it appends. The projection fold is pure and stateless;
 * accepted mutations are checked by the tool's state-machine validation
 * before they reach the log, and the fold is idempotent.
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
