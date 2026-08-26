/**
 * Ops ssh tool consumer.
 *
 * The `ssh` tool: resolves an `ssh` profile through the ops-access seam and
 * runs a remote command via ctx.shell, injecting the profile's key path,
 * port, and user@host. All shared machinery (result shape, output schema,
 * render, execute template) lives in @deepseek-ai/dsh-ops-shell-tool.
 *
 * @module @deepseek-ai/dsh-ops-tool-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerProfiledShellTool } from '@deepseek-ai/dsh-ops-shell-tool'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-ssh'

export const inject = ['shell', 'tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({})

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  registerProfiledShellTool(ctx, {
    name: 'ssh',
    kind: 'ssh',
    targetParam: 'host',
    description: 'Run a command on a remote host over SSH, using a registered ssh access profile (key, port, user@host injected automatically). Non-interactive: BatchMode is on, so anything that would prompt fails fast. Use list_access to see available host names.',
    targetParamDescription: 'SSH host profile name. Use list_access to see options.',
    commandDescription: 'Command to run on the remote host, e.g. "systemctl status ceph-osd@3". Pipes and redirects are interpreted by the LOCAL shell before ssh — keep the remote command simple.',
    buildCommand(fields, command) {
      const { host, user, key, port } = fields as {
        host: string, user: string, key?: string, port?: number
      }
      // BatchMode: never prompt (password/passphrase) — fail fast instead.
      // accept-new: trust a host key on first contact, refuse changed ones —
      // ops hosts are reached by name from the registry, not typed by hand.
      const opts = ['-o BatchMode=yes', '-o ConnectTimeout=10', '-o StrictHostKeyChecking=accept-new']
      if (key !== undefined) opts.push(`-i "${key}"`)
      if (port !== undefined) opts.push(`-p ${port}`)
      return `ssh ${opts.join(' ')} ${user}@${host} ${command}`
    },
  })
}
