/**
 * Ops access provider for Ceph.
 *
 * Validates `ceph` registry entries (`{ confPath, keyringPath }`) and expands
 * `~` in both paths. Registers into the ops-access capability seam
 * (ctx.opsAccess).
 *
 * @module @deepseek-ai/dsh-ops-access-ceph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'
import { expandHome } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-ceph'

export const inject: string[] = []

export const Config = z.object({})

// ── Provider ─────────────────────────────────────────────────────────────────

/** Zod schema for one ceph registry entry (excluding name and envelope fields). */
export const entrySchema = zod.object({
  confPath: zod.string(),
  keyringPath: zod.string(),
  name: zod.string().optional(),
})

export const provider: AccessProvider = {
  kind: 'ceph',
  schema: entrySchema,
  fieldsDoc: 'confPath: path to ceph.conf; keyringPath: path to the keyring file (~ is expanded in both); name: optional cephx user (e.g. client.dsh-test) — defaults to client.admin when omitted',
  process(entry) {
    const { confPath, keyringPath, name } = entry as zod.infer<typeof entrySchema>
    const fields: Record<string, unknown> = { confPath: expandHome(confPath), keyringPath: expandHome(keyringPath) }
    if (name !== undefined) fields.name = name
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
