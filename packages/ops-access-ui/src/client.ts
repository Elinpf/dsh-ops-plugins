/**
 * Client half for ops-access-ui: registers an `access` source on the `@`
 * trigger. Candidates come from `GET /ops-access/list` (served preset-plane
 * by the ops-access core package). When the ops preset is not mounted the
 * route 404s and this source degrades to no candidates.
 *
 * A pick inserts a ReferenceInsert whose ref is the ready-made
 * `@[kind/name](dsh-access:...)` mention from the route; the codec is the
 * identity — the full mention travels in the submitted text and the
 * preset-plane agent/pre-step listener (in @deepseek-ai/dsh-ops-access)
 * expands it.
 *
 * Bundled by esbuild into lib/client.js in the ModuleLoader lazy-CJS format.
 *
 * @module @deepseek-ai/dsh-ops-access-ui/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  InputTriggerCandidate,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger'

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-access-ui-client'
// Static inject: the loader then applies us only after inputTriggers exists —
// a ctx.get at apply time can lose the race and silently skip registration
// (ui-cordis injects it statically for this reason).
const inject = ['inputTriggers']

// ── Wire shape (mirrors the route in ops-access core) ────────────────────────

interface AccessMentionCandidate {
  kind: string
  name: string
  description?: string
  environment?: string
  mention: string
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

function apply(ctx: Context): void {
  const inputTriggers = ctx.get('inputTriggers') as
    | { registerSource(src: InputTriggerSource): () => void }
    | undefined
  if (inputTriggers === undefined) return

  const source: InputTriggerSource = {
    trigger: '@',
    name: 'access',
    order: 2,
    async candidates(_session, { query, signal }) {
      let list: AccessMentionCandidate[]
      try {
        const res = await fetch(`/ops-access/list?query=${encodeURIComponent(query)}`, { signal })
        if (!res.ok) return []
        list = await res.json() as AccessMentionCandidate[]
      } catch {
        return []
      }
      return list.map((c): InputTriggerCandidate => ({
        name: `${c.kind}/${c.name}`,
        description: c.description,
        hint: c.environment,
        value: c.mention,
      }))
    },
    onPick({ candidate }) {
      const mention = candidate.value
      if (mention === undefined) return undefined
      return {
        insert: {
          source: 'access',
          ref: mention,
          label: candidate.name,
          clipboardText: `@${candidate.name}`,
        },
      }
    },
    // Identity codec: the mention itself is the model form; the host-side
    // pre-step listener rewrites and expands it.
    codec: {
      clipboardText: (ref) => ref,
      serialize: (ref) => Promise.resolve(ref),
    },
  }
  ctx.effect(() => inputTriggers!.registerSource(source))
}

export { apply, inject, name }
