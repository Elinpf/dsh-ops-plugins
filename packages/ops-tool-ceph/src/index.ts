/**
 * Ops ceph tool consumer.
 *
 * The `ceph` tool: resolves a `ceph` profile through the ops-access seam and
 * runs the command via ctx.shell, injecting the profile's --conf and
 * --keyring paths. The command's first word picks the binary from the
 * allowlist [ceph, rbd, rados] — rbd/rados are SEPARATE binaries, not ceph
 * subcommands (`ceph rbd ls` is a mon-side 'no valid command found', which
 * once sent an agent chasing a phantom permissions problem, 2026-08-27).
 * All shared machinery (result shape, output schema, render, execute
 * template) lives in @deepseek-ai/dsh-ops-shell-tool.
 *
 * @module @deepseek-ai/dsh-ops-tool-ceph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerProfiledShellTool } from '@deepseek-ai/dsh-ops-shell-tool'
import type { CephToolConfig } from './types.js'

export type { CephToolConfig } from './types.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-ceph'

export const inject = ['shell', 'tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({
  /** Per-call shell timeout for ceph runs (ms). Slow clusters may need more. */
  timeoutMs: z.number().default(30000),
})

// ── Plugin apply ─────────────────────────────────────────────────────────────

/**
 * Known ceph-CLI stderr noise inside containers with no default keyring under
 * /etc/ceph. Credentials always arrive via the injected --keyring, so these
 * warnings are pure noise; the patterns match the two known message shapes
 * exactly (tolerating the librados timestamp/entity prefix and the variable
 * path list) — every other stderr line passes through verbatim.
 */
const STDERR_NOISE: RegExp[] = [
  // "unable to find a keyring on /etc/ceph/ceph.client.X.keyring,...: (2) No such file or directory"
  /unable to find a keyring on .*: \(-?\d+\) No such file or directory\s*$/,
  // "no keyring found at /etc/ceph/ceph.client.X.keyring, disabling cephx"
  /no keyring found at .*disabling cephx\s*$/,
]

const CEPH_BINARIES = ['ceph', 'rbd', 'rados'] as const

// ceph-ecosystem binaries this tool does NOT wrap — they run locally on a
// host, not against the mon. Named so a confused call fails with a clear
// boundary instead of the mon's misleading 'no valid command found'.
const NOT_WRAPPED = ['mount', 'umount', 'mount.ceph', 'ceph-fuse', 'ceph-volume', 'rclone', 'rbd-nbd', 'rbd-mirror'] as const

export function apply(ctx: Context, config: CephToolConfig): void {
  registerProfiledShellTool(ctx, {
    timeoutMs: config.timeoutMs,
    name: 'ceph',
    kind: 'ceph',
    targetParam: 'cluster',
    description: 'Execute a ceph, rbd or rados command on a specified Ceph cluster. The plugin automatically injects the correct --conf and --keyring credentials (shown as <id@tier:field> references). Use list_access to see available cluster names.',
    targetParamDescription: 'Ceph cluster profile name. Use list_access to see options.',
    commandDescription: 'A ceph, rbd or rados command. Bare ceph subcommands work as-is (health detail, osd tree, df). rbd and rados are SEPARATE binaries — include the binary name as the first word (rbd ls -p rbd-pool, rados df); they share the injected --conf/--keyring/--name. Discover pool names with "osd pool ls". Under an ro credential, write verbs (and some reads like rbd ls without class-read caps) fail at the mon/osd with a real permission error — that is the enforcement layer working, not a tool bug.',
    stderrNoise: STDERR_NOISE,
    buildCommand(fields, command, ref) {
      const { name } = fields as { name?: string }
      // --name matters: a non-admin keyring without it still authenticates as
      // client.admin and fails with RADOS permission denied. The cephx entity
      // name is not secret — it stays inline; only the file paths get tokens.
      const nameArg = name ? ` --name ${name}` : ''
      const trimmed = command.trim()
      const first = trimmed.split(/\s+/, 1)[0] ?? ''
      if ((NOT_WRAPPED as readonly string[]).includes(first)) {
        throw new Error('the ceph tool wraps ceph/rbd/rados against the cluster only — \'' + first + '\' runs locally on a host; use the ssh tool for that')
      }
      // rbd and rados are SEPARATE binaries, not ceph subcommands — select by
      // first word (an explicit 'ceph' prefix is stripped too); a bare word
      // is a ceph subcommand and stays. Read-only-ness is enforced by the
      // credential's caps at the mon/osd, never by the binary name.
      const binary = (CEPH_BINARIES as readonly string[]).includes(first) ? first : 'ceph'
      const rest = first === binary ? trimmed.slice(first.length).trimStart() : trimmed
      return `${binary} --conf=${ref('conf')} --keyring=${ref('keyring')}${nameArg} ${rest}`
    },
  })
}
