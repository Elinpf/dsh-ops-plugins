/**
 * Ops-access-ui: carries the browser half of the @-access-mention feature.
 *
 * The host row exists for exactly one reason: client-half discovery. The web
 * app's ClientModuleRegistry scans the composed HOST cordis entries for
 * packages with `dsh.client`, so this package must stay mounted host-plane
 * for the panel script to reach the browser. The host side itself is empty —
 * the candidate data route lives in the ops-access core package (preset
 * plane, next to the data; see its src/index.ts), because reaching the
 * preset-realm service from here would require stateful dsh internals that
 * dual-instance under an external package's node_modules.
 *
 * @module @elinpf/dsh-ops-access-ui
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-ui'

export const inject: string[] = []

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({})

export function apply(_ctx: Context, _config: Record<string, never>): void {
  // Intentionally empty — see the module doc.
}
