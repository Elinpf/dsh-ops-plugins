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
    description: 'Execute a ceph command on a specified Ceph cluster. The plugin automatically injects the correct --conf and --keyring credentials (shown as <id@tier:field> references). Use list_access to see available cluster names.',
    targetParamDescription: 'Ceph cluster profile name. Use list_access to see options.',
    commandDescription: 'ceph subcommand WITHOUT the ceph prefix. Examples: health detail, osd tree, df',
    buildCommand(fields, command, ref) {
      const { name } = fields as { name?: string }
      // --name matters: a non-admin keyring without it still authenticates as
      // client.admin and fails with RADOS permission denied. The cephx entity
      // name is not secret — it stays inline; only the file paths get tokens.
      const nameArg = name ? ` --name ${name}` : ''
      return `ceph --conf=${ref('conf')} --keyring=${ref('keyring')}${nameArg} ${command}`
    },
  })
}
