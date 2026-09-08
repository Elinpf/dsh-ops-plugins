/**
 * Ops access provider for SSH.
 *
 * Two kinds live here:
 *
 * - `ssh` — a HOST entry: `{ host, user?, key?, password?, cred?, port? }`.
 *   The credential (key or password) may be carried inline, but the intended
 *   shape is a `cred` reference to a shared `ssh-cred` entry — register the
 *   secret once, point N hosts at it, rotate it in one place. Fields set on
 *   the host entry override the referenced credential's (core merges the
 *   reference UNDER the entry; see `references` in the core seam).
 * - `ssh-cred` — a reusable CREDENTIAL entry: `{ user?, key?, password? }`
 *   (at least one of key/password). Holds no host; it only resolves as the
 *   target of an ssh entry's `cred` reference.
 *
 * When the admin UI receives private-key / password CONTENT (instead of a
 * path), core writes it to a managed file under ~/.dsh-ops/credentials/ and
 * stores the path in the registry. The provider expands ~ in the path for
 * ssh -i / sshpass -f. Pasted key content is normalized to end with exactly
 * one newline and deep-parsed at save time (ssh-keygen -y) — both classic
 * paste losses (2026-08-27).
 *
 * @module @elinpf/dsh-ops-access-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccessProvider } from '@elinpf/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@elinpf/dsh-ops-access'
import type { SshCredEntry, SshEntry, SshProviderConfig } from './types.js'

export type { SshCredEntry, SshEntry, SshProviderConfig } from './types.js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-ssh'

export const inject: string[] = []

export const Config = z.object({
  /** Save-time validation: timeout for the `ssh-keygen -y` parse (ms). */
  validateTimeoutMs: z.number().default(5000),
})

// ── Provider ─────────────────────────────────────────────────────────────────

/** Zod schema for one ssh HOST registry entry (excluding name and the envelope fields). */
export const entrySchema = zod.object({
  host: zod.string(),
  user: zod.string().optional(),
  key: zod.string().optional(),
  password: zod.string().optional(),
  cred: zod.string().optional(),
  port: zod.number().optional(),
})

/**
 * Zod schema for one ssh-cred CREDENTIAL entry: the shared secret half of the
 * host/credential split. At least one auth method (key or password) is
 * required — an empty credential resolves for every host that references it
 * and fails them all at connection time, so reject it at save time.
 */
export const credEntrySchema = zod.object({
  user: zod.string().optional(),
  key: zod.string().optional(),
  password: zod.string().optional(),
}).refine((e) => e.key !== undefined || e.password !== undefined, {
  message: 'an ssh-cred entry needs at least one auth method: key or password',
})

// Save-time guard in two layers: a cheap armor check, then a REAL parse —
// ssh-keygen -y derives the public key with the same parser ssh runs at
// connection time. A structurally plausible but corrupt paste fails here
// with a clear message instead of 'error in libcrypto' mid-investigation,
// and a passphrase-protected key gets its BatchMode explanation up front.
async function validateKeyContent(content: string, keygenTimeoutMs: number): Promise<string | null> {
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(content) || !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(content)) {
    return 'not a private key — expected a -----BEGIN ... PRIVATE KEY----- block (paste the full key file)'
  }
  const dir = await mkdtemp(join(tmpdir(), 'ops-ssh-key-'))
  try {
    const keyPath = join(dir, 'key')
    await writeFile(keyPath, content, { mode: 0o600 })
    try {
      await execFileAsync('ssh-keygen', ['-y', '-P', '', '-f', keyPath], { timeout: keygenTimeoutMs })
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
}

/**
 * Save-time validator for file-field content, shared by both kinds: `key`
 * goes through the ssh-keygen deep parse; `password` must be single-line —
 * sshpass -f reads only the FIRST line, so an interior newline would
 * silently truncate the password at connection time. (Core's trailing-newline
 * normalization has already run, so any newline before the final one is
 * interior.)
 */
function validateContent(keygenTimeoutMs: number) {
  return (field: string, content: string): string | null | Promise<string | null> => {
    if (field === 'key') return validateKeyContent(content, keygenTimeoutMs)
    if (field === 'password') {
      const body = content.endsWith('\n') ? content.slice(0, -1) : content
      if (body.includes('\n') || body.includes('\r')) {
        return 'a password must be a single line — sshpass -f reads only the first line of the file'
      }
      return null
    }
    return null
  }
}

/** ssh needs a login user; with the host/credential split it may come from either side of the merge. */
function validateResolvedUser(fields: Record<string, unknown>): string | null {
  if (typeof fields.user !== 'string' || fields.user.length === 0) {
    return 'no login user — set user on the host entry, or on the ssh-cred entry its cred field references'
  }
  return null
}

export const provider: AccessProvider = {
  kind: 'ssh',
  schema: entrySchema,
  fieldsDoc: 'host: hostname or IP; user: optional login user (overrides the credential\'s); key: optional private-key content; password: optional password content (sshpass must be installed on the dsh host); cred: optional ssh-cred profile name — the shared credential, fields here override it; port: optional, default 22',
  fileFields: ['key', 'password'],
  references: { cred: 'ssh-cred' },
  validateResolved: validateResolvedUser,
  derivationDoc: 'ssh has no read-only shell — the credential lives in the ro tier and every use is grant-gated; to provision a dedicated key during an approved session: generate a fresh keypair (ssh-keygen -t ed25519), append the public key to the target user\'s authorized_keys, then register the private key via register_access',
  process(entry) {
    const { host, user, key, password, cred, port } = entry as SshEntry
    const fields: Record<string, unknown> = { host }
    if (user !== undefined) fields.user = user
    if (key !== undefined) fields.key = expandHome(key)
    if (password !== undefined) fields.password = expandHome(password)
    if (cred !== undefined) fields.cred = cred
    if (port !== undefined) fields.port = port
    return fields
  },
  // Core normalizes the trailing newline before this hook (PEM requires
  // the END line newline-terminated; a paste that lost exactly that byte
  // failed in libcrypto at first use — 2026-08-27).
  normalizeTrailingNewline: true,
  validateContent: validateContent(5000),
}

export const credProvider: AccessProvider = {
  kind: 'ssh-cred',
  schema: credEntrySchema,
  fieldsDoc: 'user: optional default login user (hosts may override); key: optional private-key content; password: optional password content (sshpass must be installed on the dsh host). At least one of key/password is required. Referenced by ssh entries via their cred field — register the secret once, point many hosts at it',
  fileFields: ['key', 'password'],
  process(entry) {
    const { user, key, password } = entry as SshCredEntry
    const fields: Record<string, unknown> = {}
    if (user !== undefined) fields.user = user
    if (key !== undefined) fields.key = expandHome(key)
    if (password !== undefined) fields.password = expandHome(password)
    return fields
  },
  normalizeTrailingNewline: true,
  validateContent: validateContent(5000),
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: SshProviderConfig): void {
  registerAccessProvider(ctx, {
    ...provider,
    validateContent: validateContent(config.validateTimeoutMs),
  })
  registerAccessProvider(ctx, {
    ...credProvider,
    validateContent: validateContent(config.validateTimeoutMs),
  })
}
