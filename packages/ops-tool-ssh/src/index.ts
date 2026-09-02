/**
 * Ops ssh tool consumer.
 *
 * The `ssh` tool: resolves an `ssh` profile through the ops-access seam and
 * runs a remote command via ctx.shell, injecting the profile's key path,
 * port, and user@host. The remote command is shell-quoted as ONE argument —
 * the local shell must never split it: an unquoted && chain once came one
 * auth failure short of deleting control-plane manifests remotely while
 * `restoring` them on the LOCAL machine (2026-08-27 near-miss). All shared
 * machinery (result shape, output schema, render, execute template) lives
 * in @elinpf/dsh-ops-shell-tool.
 *
 * @module @elinpf/dsh-ops-tool-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerProfiledShellTool, shellQuote } from '@elinpf/dsh-ops-shell-tool'
import type { SshToolConfig } from './types'

export type { SshToolConfig } from './types'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-ssh'

export const inject = ['shell', 'tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({
  /** Per-call shell timeout for ssh runs (ms). */
  timeoutMs: z.number().default(30000),
  /** ssh -o ConnectTimeout value (seconds) — how long to wait for the TCP handshake. */
  connectTimeoutSeconds: z.number().default(10),
})

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: SshToolConfig): void {
  registerProfiledShellTool(ctx, {
    timeoutMs: config.timeoutMs,
    name: 'ssh',
    kind: 'ssh',
    targetParam: 'host',
    description: 'Run a command on a remote host over SSH, using a registered ssh access profile (key, port, user@host injected automatically). Non-interactive: BatchMode is on, so anything that would prompt fails fast. Use list_access to see available host names.',
    targetParamDescription: 'SSH host profile name. Use list_access to see options.',
    commandDescription: 'Command to run on the remote host, e.g. "systemctl status ceph-osd@3". The whole string is passed as ONE shell-quoted argument and run by the remote shell: pipes, redirects, &&, ; and $() all execute on the REMOTE host — nothing is interpreted locally.',
    buildCommand(fields, command, ref) {
      const { host, user, key, port } = fields as {
        host: string, user: string, key?: string, port?: number
      }
      // BatchMode: never prompt (password/passphrase) — fail fast instead.
      // accept-new: trust a host key on first contact, refuse changed ones —
      // ops hosts are reached by name from the registry, not typed by hand.
      const opts = ['-o BatchMode=yes', `-o ConnectTimeout=${config.connectTimeoutSeconds}`, '-o StrictHostKeyChecking=accept-new']
      // Only the key path gets a credential token; user@host/port stay inline.
      if (key !== undefined) opts.push(`-i ${ref('key')}`)
      if (port !== undefined) opts.push(`-p ${port}`)
      // The remote command goes out as ONE single-quoted argument: sshd
      // re-runs it through the remote shell, where &&, pipes, redirects and
      // $() all belong. Left unquoted, the LOCAL shell would split the line
      // and run the later segments here as root (2026-08-27 near-miss).
      return `ssh ${opts.join(' ')} ${user}@${host} ${shellQuote(command)}`
    },
  })
}
