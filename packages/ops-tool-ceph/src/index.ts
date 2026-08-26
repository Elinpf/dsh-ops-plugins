/**
 * Ops ceph tool consumer.
 *
 * The `ceph` tool: resolves a `ceph` profile through the ops-access seam and
 * runs the command via ctx.shell, injecting the profile's --conf and
 * --keyring paths. All shared machinery (result shape, output schema,
 * render, execute template) lives in @deepseek-ai/dsh-ops-shell-tool.
 *
 * @module @deepseek-ai/dsh-ops-tool-ceph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerProfiledShellTool } from '@deepseek-ai/dsh-ops-shell-tool'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-ceph'

export const inject = ['shell', 'tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({})

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  registerProfiledShellTool(ctx, {
    name: 'ceph',
    kind: 'ceph',
    targetParam: 'cluster',
    description: 'Execute a ceph command on a specified Ceph cluster. The plugin automatically injects the correct --conf and --keyring paths. Use list_access to see available cluster names.',
    targetParamDescription: 'Ceph cluster profile name. Use list_access to see options.',
    commandDescription: 'ceph subcommand WITHOUT the ceph prefix. Examples: health detail, osd tree, df',
    buildCommand(fields, command) {
      const { conf, keyring, name } = fields as { conf: string, keyring: string, name?: string }
      // --name matters: a non-admin keyring without it still authenticates as
      // client.admin and fails with RADOS permission denied.
      const nameArg = name ? ` --name ${name}` : ''
      return `ceph --conf="${conf}" --keyring="${keyring}"${nameArg} ${command}`
    },
  })
}
