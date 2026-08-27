/**
 * Prompt half of the environment inventory (preset plane).
 *
 * Registers the one-line methodology section ("run environment overview
 * before investigating") through the ops-prompts channel. Split from the
 * tool entry because of realm topology: the tool needs the opsAccess
 * isolate realm (ops-access-registry group), the prompt needs the
 * opsPrompts realm (ops-orchestration group), and entry-local realms are
 * invisible across groups. Mount this row inside the ops-orchestration
 * group; see ops-preset.yml.
 *
 * @module @deepseek-ai/dsh-ops-tool-environment/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { OpsPromptsHandle } from '@deepseek-ai/dsh-ops-prompts'
import { STATIC_PROMPT } from './doctrine.js'

// ── Module augmentation: declare the opsPrompts service on Context ──────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsPrompts?: OpsPromptsHandle
  }
}

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-environment-prompt'

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  const registerThroughHandle = (opsPrompts: OpsPromptsHandle): void => {
    opsPrompts.registerMethodology({
      name: 'environment:usage',
      order: 250,
      text: STATIC_PROMPT,
    })
  }

  // The preset mounts the group's plugins concurrently, so a one-shot
  // ctx.get can lose the race against ops-prompts' provide — fall back to
  // ctx.inject, which defers until the service arrives. When ops-prompts is
  // genuinely absent, the tool description and action=help still carry the
  // usage documentation.
  const immediate = ctx.get('opsPrompts')
  if (immediate !== undefined) {
    registerThroughHandle(immediate)
  } else {
    ctx.inject(['opsPrompts'], (pctx: Context) => {
      registerThroughHandle(pctx.opsPrompts!)
    })
  }
}
