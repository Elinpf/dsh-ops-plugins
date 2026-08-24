/**
 * Ops access provider for SSH.
 *
 * Validates `ssh` registry entries (`{ host, user, keyPath?, port? }`) and
 * expands `~` in the key path. Registers into the ops-access capability seam
 * (ctx.opsAccess).
 *
 * @module @deepseek-ai/dsh-ops-access-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'
import { expandHome } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-ssh'

export const inject: string[] = []

export const Config = z.object({})

// ── Provider ─────────────────────────────────────────────────────────────────

/** Zod schema for one ssh registry entry (excluding name and envelope fields). */
export const entrySchema = zod.object({
  host: zod.string(),
  user: zod.string(),
  keyPath: zod.string().optional(),
  port: zod.number().optional(),
})

export const provider: AccessProvider = {
  kind: 'ssh',
  schema: entrySchema,
  fieldsDoc: 'host: hostname or IP; user: login user; keyPath: optional private-key path (~ is expanded); port: optional, default 22',
  process(entry) {
    const { host, user, keyPath, port } = entry as zod.infer<typeof entrySchema>
    const fields: Record<string, unknown> = { host, user }
    if (keyPath !== undefined) fields.keyPath = expandHome(keyPath)
    if (port !== undefined) fields.port = port
    return fields
  },
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  // The preset mounts the group's rows concurrently, so a static inject on
  // 'opsAccess' can deadlock the loader against the definition row. Defer via
  // ctx.inject — the callback fires once the service arrives (same pattern as
  // ops-trace → ops-prompts).
  ctx.inject(['opsAccess'], (pctx: Context) => {
    pctx.effect(() => pctx.opsAccess!.register(provider))
  })
}
