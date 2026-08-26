/**
 * Ops access provider for SSH.
 *
 * Validates `ssh` registry entries (`{ host, user, key?, port? }`). When the
 * admin UI receives private-key CONTENT (instead of a path), core writes it
 * to a managed file under ~/.dsh-ops/credentials/ and stores the path in the
 * registry. The provider expands ~ in the path for ssh -i.
 *
 * @module @deepseek-ai/dsh-ops-access-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-ssh'

export const inject: string[] = []

export const Config = z.object({})

// ── Provider ─────────────────────────────────────────────────────────────────

/** Zod schema for one ssh registry entry (excluding name and envelope fields). */
export const entrySchema = zod.object({
  host: zod.string(),
  user: zod.string(),
  key: zod.string().optional(),
  port: zod.number().optional(),
})

export const provider: AccessProvider = {
  kind: 'ssh',
  schema: entrySchema,
  fieldsDoc: 'host: hostname or IP; user: login user; key: optional private-key content; port: optional, default 22',
  fileFields: ['key'],
  derivationDoc: 'ssh has no read-only shell — the credential lives in the ro tier and every use is grant-gated; to provision a dedicated key during an approved session: generate a fresh keypair (ssh-keygen -t ed25519), append the public key to the target user\'s authorized_keys, then register the private key via register_access',
  process(entry) {
    const { host, user, key, port } = entry as zod.infer<typeof entrySchema>
    const fields: Record<string, unknown> = { host, user }
    if (key !== undefined) fields.key = expandHome(key)
    if (port !== undefined) fields.port = port
    return fields
  },
  // Save-time guard against corrupt pastes: the key must look like a PEM/
  // OpenSSH private key block. Structural only — the key is never parsed.
  validateContent(field, content) {
    if (field !== 'key') return null
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(content) || !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(content)) {
      return 'not a private key — expected a -----BEGIN ... PRIVATE KEY----- block (paste the full key file)'
    }
    return null
  },
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  registerAccessProvider(ctx, provider)
}
