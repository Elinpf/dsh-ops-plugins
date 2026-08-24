/**
 * Ops-trace-ui: the host-plane half of the trace feature.
 *
 * Registers the shared `trace` session projection (defined once in
 * @deepseek-ai/dsh-ops-tool-trace) and carries the web client bundle — the
 * investigation-tree panel. Client-half discovery is runtime: the web app's
 * ClientModuleRegistry scans the composed host cordis entries, so this
 * package must stay mounted host-plane via its cordis.patch.yml row or the
 * panel never reaches the browser.
 *
 * Registers no tools and no prompt sections. The trace tool and its
 * methodology live in @deepseek-ai/dsh-ops-tool-trace, mounted preset-plane.
 *
 * @module @deepseek-ai/dsh-ops-trace-ui
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { traceProjection } from '@deepseek-ai/dsh-ops-tool-trace'

// No local module augmentation: the sessionProjections typing lives in
// ops-tool-trace's index (the shared home) and applies globally via its d.ts.

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-trace-ui'
const inject: string[] = []

// ── Config ───────────────────────────────────────────────────────────────────

const Config = z.object({})

function apply(ctx: Context, _config: Record<string, never>): void {
  // sessionProjections is a host-plane service; a static inject is not
  // declared so the loader does not order this row against it — defer with
  // ctx.inject, the same pattern the tool half uses.
  ctx.inject(['sessionProjections'], (pctx: Context) => {
    pctx.sessionProjections!.register(traceProjection)
  })
}

export { Config, apply, inject, name }
