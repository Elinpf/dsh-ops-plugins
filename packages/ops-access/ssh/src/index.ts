/**
 * Ops access provider for SSH.
 *
 * Validates `ssh` registry entries (`{ host, user, key?, port? }`). When the
 * admin UI receives private-key CONTENT (instead of a path), core writes it
 * to a managed file under ~/.dsh-ops/credentials/ and stores the path in the
 * registry. The provider expands ~ in the path for ssh -i. Pasted key
 * content is normalized to end with exactly one newline and deep-parsed at
 * save time (ssh-keygen -y) — both classic paste losses (2026-08-27).
 *
 * @module @deepseek-ai/dsh-ops-access-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@deepseek-ai/dsh-ops-access'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
  // Core normalizes the trailing newline before this hook (PEM requires
  // the END line newline-terminated; a paste that lost exactly that byte
  // failed in libcrypto at first use — 2026-08-27).
  normalizeTrailingNewline: true,
  // Save-time guard in two layers: a cheap armor check, then a REAL parse —
  // ssh-keygen -y derives the public key with the same parser ssh runs at
  // connection time. A structurally plausible but corrupt paste fails here
  // with a clear message instead of 'error in libcrypto' mid-investigation,
  // and a passphrase-protected key gets its BatchMode explanation up front.
  async validateContent(field, content) {
    if (field !== 'key') return null
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(content) || !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(content)) {
      return 'not a private key — expected a -----BEGIN ... PRIVATE KEY----- block (paste the full key file)'
    }
    const dir = await mkdtemp(join(tmpdir(), 'ops-ssh-key-'))
    try {
      const keyPath = join(dir, 'key')
      await writeFile(keyPath, content, { mode: 0o600 })
      try {
        await execFileAsync('ssh-keygen', ['-y', '-P', '', '-f', keyPath], { timeout: 5000 })
        return null
      } catch (err) {
        const e = err as { code?: string, stderr?: unknown, message?: string }
        // No ssh-keygen on this host: fall back to the armor gate above —
        // the deep parse is a bonus, not a new hard dependency.
        if (e.code === 'ENOENT') return null
        const stderr = typeof e.stderr === 'string' && e.stderr.length > 0 ? e.stderr : String(e.message ?? err)
        if (/passphrase/i.test(stderr) || content.includes('ENCRYPTED')) {
          return 'the private key is passphrase-protected — the ssh tool runs BatchMode=yes and cannot answer prompts; remove the passphrase first (ssh-keygen -p)'
        }
        const detail = stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).pop() ?? 'unknown parse error'
        return 'ssh-keygen cannot parse this key (' + detail + ') — the paste is corrupt; re-copy the key file verbatim'
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  registerAccessProvider(ctx, provider)
}
