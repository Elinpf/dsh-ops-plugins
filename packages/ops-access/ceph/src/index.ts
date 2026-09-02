/**
 * Ops access provider for Ceph.
 *
 * Validates `ceph` registry entries (`{ conf, keyring, name? }`). The admin
 * UI accepts ceph.conf and keyring CONTENT; core writes it to managed files
 * under ~/.dsh-ops/credentials/ and stores the path in the registry. The
 * provider expands ~ in the path for the tool's --conf/--keyring flags.
 *
 * @module @elinpf/dsh-ops-access-ceph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { execFile } from 'node:child_process'
import type { AccessProvider } from '@elinpf/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@elinpf/dsh-ops-access'
import type { CapAssessment, ProbeFailure, ProbeOutcome } from './types.js'

// Pure types live in types.ts (zero runtime code); re-exported here so
// existing `from './index.js'` type imports keep working.
export type { CapAssessment, ProbeFailure, ProbeOutcome } from './types.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-ceph'

export const inject: string[] = []

export const Config = z.object({
  /** Save-time probe: timeout for the `ceph auth get` call (ms). Slow clusters may need more. */
  probeTimeoutMs: z.number().default(10000),
})

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
  // A missing trailing newline used to be rejected here (ceph's buffer
  // parser rejects it); core now normalizes it away at write time
  // (normalizeTrailingNewline). What remains is structure: key lines
  // indented under their [section], strict base64 — caught here instead of
  // surfacing as "cannot parse buffer: Malformed input" at connection time.
  // Structural only — no connectivity checks.
  normalizeTrailingNewline: true,
  // Ticket 10: re-read the entity's caps at save time and compare with the tier.
  probe: probeCeph,
  validateContent(field, content) {
    if (field !== 'conf' && field !== 'keyring') return null
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


// ── Capability probe (ticket 10) ─────────────────────────────────────────────

/** Parse `caps <daemon> = "<value>"` lines from `ceph auth get` output. */
export function parseCaps(output: string): Record<string, string> {
  const caps: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*caps (\w+) = "(.*)"\s*$/)
    if (m) caps[m[1]] = m[2]
  }
  return caps
}

/**
 * A cap value grants write when any permission token carries the w flag.
 * Tokens after 'allow' are permission bundles (r/w/x in any order — 'w',
 * 'rw', 'rwx', 'wx' are ALL writable) or '*'; qualifiers like 'pool=foo'
 * never grant write by themselves. NB: the keyword 'allow' itself
 * contains a 'w' — match permission-bundle tokens, never the keyword
 * (review fix: the exact-token version missed 'rwx'/'wx').
 */
function capIsWritable(value: string): boolean {
  return value.split(/\s+/).some((t) => t === '*' || (/^[rwx]+$/.test(t) && t.includes('w')))
}

/**
 * Pure caps-vs-tier assessment (unit-tested directly). ro verifies when
 * every daemon cap is read-only ('allow r', optionally with class-read —
 * librbd object-class reads, ticket 14); rw verifies when at least one cap
 * grants write.
 */
export function assessCephCaps(caps: Record<string, string>, tier: 'ro' | 'rw'): CapAssessment {
  const summary = Object.entries(caps).map(([d, v]) => d + '="' + v + '"').join(' ')
  if (Object.keys(caps).length === 0) return { status: 'mismatch', detail: 'auth get returned no caps lines' }
  if (tier === 'ro') {
    const writable = Object.entries(caps).filter(([, v]) => capIsWritable(v)).map(([d]) => d)
    if (writable.length === 0) return { status: 'verified' }
    return { status: 'mismatch', detail: 'claims ro but caps grant write on ' + writable.join('/') + ' — ' + summary }
  }
  if (Object.values(caps).some(capIsWritable)) return { status: 'verified' }
  return { status: 'mismatch', detail: 'claims rw but no cap grants write — ' + summary }
}

/**
 * Classify an auth-get failure (unit-tested directly). stderr is classified
 * by substring, never surfaced: ceph error messages can carry file paths.
 * A tight ro entity CANNOT self-read the auth database (EACCES) — that is
 * normal, and safe: an over-privileged credential sitting in the ro slot
 * would have enough privilege for auth get and would have been caught by
 * the caps comparison.
 */
export function cephProbeFailure(tier: 'ro' | 'rw', errText: string): ProbeFailure {
  if (tier === 'ro' && /EACCES|access denied/i.test(errText)) {
    return { status: 'unverifiable', detail: 'entity cannot self-read its caps (normal for a tight ro entity — an over-privileged credential in this slot would have the privilege to auth get and would have been caught)' }
  }
  return { status: 'unverifiable', detail: 'ceph auth get could not run (cluster unreachable or ceph CLI missing)' }
}

async function probeCeph(fields: Record<string, unknown>, tier: 'ro' | 'rw', timeoutMs = 10000): Promise<ProbeOutcome> {
  const name = typeof fields.name === 'string' ? fields.name : 'client.admin'
  const conf = String(fields.conf ?? '')
  const keyring = String(fields.keyring ?? '')
  const result = await new Promise<{ output: string | null, errText: string }>((resolve) => {
    execFile('ceph', ['--conf', conf, '--keyring', keyring, '--name', name, 'auth', 'get', name],
      { timeout: timeoutMs },
      (err, stdout, stderr) => resolve(err
        ? { output: null, errText: String(stderr ?? '') + ' ' + String(err.message ?? '') }
        : { output: stdout, errText: '' }))
  })
  if (result.output === null) return cephProbeFailure(tier, result.errText)
  return assessCephCaps(parseCaps(result.output), tier)
}
// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: { probeTimeoutMs: number }): void {
  registerAccessProvider(ctx, {
    ...provider,
    probe: (fields, tier) => probeCeph(fields, tier, config.probeTimeoutMs),
  })
}
