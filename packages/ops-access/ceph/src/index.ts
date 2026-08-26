/**
 * Ops access provider for Ceph.
 *
 * Validates `ceph` registry entries (`{ conf, keyring, name? }`). The admin
 * UI accepts ceph.conf and keyring CONTENT; core writes it to managed files
 * under ~/.dsh-ops/credentials/ and stores the path in the registry. The
 * provider expands ~ in the path for the tool's --conf/--keyring flags.
 *
 * @module @deepseek-ai/dsh-ops-access-ceph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-ceph'

export const inject: string[] = []

export const Config = z.object({})

// ── Provider ─────────────────────────────────────────────────────────────────

/** Zod schema for one ceph registry entry (excluding name and envelope fields). */
export const entrySchema = zod.object({
  conf: zod.string(),
  keyring: zod.string(),
  name: zod.string().optional(),
})

export const provider: AccessProvider = {
  kind: 'ceph',
  schema: entrySchema,
  fieldsDoc: 'conf: ceph.conf content; keyring: keyring content; name: optional cephx user (e.g. client.dsh-test) — defaults to client.admin when omitted',
  fileFields: ['conf', 'keyring'],
  derivationDoc: "from the rw keyring: ceph auth add client.<id>-ro mon 'allow r' osd 'allow r' mds 'allow r' mgr 'allow r' (naming convention: client.<id>-ro), export it with ceph auth get client.<id>-ro, then register via register_access with the keyring content, a copy of conf, and name set to client.<id>-ro — verify with ceph status",
  process(entry) {
    const { conf, keyring, name } = entry as zod.infer<typeof entrySchema>
    const fields: Record<string, unknown> = { conf: expandHome(conf), keyring: expandHome(keyring) }
    if (name !== undefined) fields.name = name
    return fields
  },
  // Save-time guard against corrupt pastes. ceph's buffer parser rejects
  // input without a trailing newline and requires key lines indented under
  // their [section] — both are classic copy-paste losses, so they are caught
  // here instead of surfacing as "cannot parse buffer: Malformed input" at
  // connection time. Structural only — no connectivity checks.
  validateContent(field, content) {
    if (field !== 'conf' && field !== 'keyring') return null
    if (!content.endsWith('\n')) {
      return 'content must end with a newline — ceph rejects buffers without one (often lost when pasting)'
    }
    if (field === 'conf') {
      if (!/^\[global\][\t ]*$/m.test(content)) return 'no [global] section — paste the full ceph.conf'
      if (!/^[\t ]*mon_host[\t ]*=/m.test(content)) return 'no mon_host set — paste the full ceph.conf'
      return null
    }
    // keyring
    if (!/^\[client\.[^\]]+\][\t ]*$/m.test(content)) return 'no [client.<name>] section — paste the full keyring'
    const keyMatch = content.match(/^[\t ]+key[\t ]*=[\t ]*(\S+)[\t ]*$/m)
    if (!keyMatch) {
      return 'no indented "key = <base64>" line — ceph requires the key line to be indented under its [client.x] section'
    }
    // Strict base64 alphabet + decoded length >= 16 bytes (cephx AES keys
    // are longer; this only rules out garbled pastes). Decoded length is
    // derived from the encoded length — no Buffer dependency here.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyMatch[1]) || keyMatch[1].length < 24) {
      return 'the key value is not valid base64 (or too short for a cephx key)'
    }
    return null
  },
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  registerAccessProvider(ctx, provider)
}
