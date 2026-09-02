/**
 * Ops kubectl tool consumer.
 *
 * Registers two model-facing tools on top of the ops-access capability seam:
 *
 * - `kubectl` — resolves a `k8s` profile and runs the command via ctx.shell,
 *   injecting the profile's --kubeconfig path. All shared machinery (result
 *   shape, output schema, render, execute template) lives in
 *   @elinpf/dsh-ops-shell-tool.
 * - `list_access` — groups `ctx.opsAccess.listAll()` by kind. Envelope fields
 *   plus per-tier readiness only (kind/name/displayName/description/environment,
 *   ro/rw flags); profile `fields` (paths, connection params) never appear in
 *   this tool's output. listAll (not list) so rw-only entries — awaiting ro
 *   derivation — are visible to the agent.
 *
 * @module @elinpf/dsh-ops-tool-kubectl
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerProfiledShellTool } from '@elinpf/dsh-ops-shell-tool'
import type { AdminEntry, AdminTierStatus, OpsAccess } from '@elinpf/dsh-ops-access'
import type { ListedProfile, ListAccessResult } from './types.js'

// Pure types live in ./types.js; re-export so existing imports keep working.
export type { ListedProfile, ListAccessResult } from './types.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-kubectl'

export const inject = ['shell', 'tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({
  /** Per-call shell timeout for kubectl runs (ms). Slow clusters may need more. */
  timeoutMs: z.number().default(30000),
})

// ── list_access helpers ──────────────────────────────────────────────────────

/** Compact probe label for one tier: verified / failed / unverifiable / unprobed. */
function probeLabel(status: AdminTierStatus): string {
  if (status.probe === undefined) return '声明未核验'
  if (status.probe.status === 'verified') return '已核验'
  if (status.probe.status === 'mismatch') return '核验失败: ' + (status.probe.detail ?? '')
  return '无法核验'
}

function toListedProfile(e: AdminEntry): ListedProfile {
  const listed: ListedProfile = { name: e.name, ro: e.tiers.ro.ok, rw: e.tiers.rw.ok }
  const bits = (['ro', 'rw'] as const).filter((t) => e.tiers[t].ok).map((t) => t + ' ' + probeLabel(e.tiers[t]))
  if (bits.length > 0) listed.probe = bits.join(' / ')
  if (e.envelope.name !== undefined) listed.displayName = e.envelope.name
  if (e.envelope.description !== undefined) listed.description = e.envelope.description
  if (e.envelope.environment !== undefined) listed.environment = e.envelope.environment
  return listed
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: { timeoutMs: number }): void {
  registerProfiledShellTool(ctx, {
    timeoutMs: config.timeoutMs,
    name: 'kubectl',
    kind: 'k8s',
    targetParam: 'cluster',
    description: 'Execute a kubectl command on a specified K8s cluster. The plugin automatically injects the correct --kubeconfig credential (shown as a <id@tier:field> reference). Use list_access to see available cluster names. The command runs through a local shell: separators like ; | && are parsed by the shell before kubectl sees them, so to chain multiple kubectl commands repeat the full kubectl prefix (including the --kubeconfig=<id@tier:field> reference) after each separator — or make separate calls.',
    targetParamDescription: 'K8s cluster profile name. Use list_access to see options.',
    commandDescription: 'kubectl subcommand WITHOUT the kubectl prefix. Examples: get pods -n default, describe node node-1. One call = one kubectl subcommand: the line is concatenated after the kubectl invocation, so a pipe applies locally to its output (useful: get pods | grep Running), but ; && and $() start NEW local commands that do NOT inherit the kubectl prefix — never use them, make separate calls instead.',
    buildCommand(fields, command, ref) {
      return `kubectl --kubeconfig=${ref('kubeconfigPath')} ${command}`
    },
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_access',
    description: 'List all registered ops access profiles (e.g. K8s clusters), grouped by kind. Shows name, description, and environment only — no paths or connection details. Call with help: true to learn how to add or edit profiles in the registry file.',
    parameters: {
      help: { type: 'boolean', description: 'Return the registry management doc (file location, format, per-kind fields) instead of the profile listing.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          help: { type: 'string' },
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                profiles: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true },
                      displayName: { type: 'string' },
                      description: { type: 'string' },
                      environment: { type: 'string' },
                      ro: { type: 'boolean', required: true },
                      rw: { type: 'boolean', required: true },
                      probe: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.help) {
          return [{ type: 'text' as const, text: value.help }]
        }
        if (value.total === 0) {
          return [{ type: 'text' as const, text: 'No access profiles registered — the ops-access registry file is empty or does not exist.' }]
        }
        const lines: string[] = []
        for (const group of value.groups) {
          lines.push(`${group.kind} (${group.profiles.length}):`)
          for (const p of group.profiles) {
            const dn = p.displayName ? ` (${p.displayName})` : ''
            const env = p.environment ? ` [${p.environment}]` : ''
            const desc = p.description ? ` — ${p.description}` : ''
            const tier = !p.ro
              ? (p.rw ? ' [rw only — derive the ro tier via register_access]' : ' [no usable tier]')
              : ''
            const probe = p.probe !== undefined ? ` [probe: ${p.probe}]` : ''
            lines.push(`- ${p.name}${dn}${env}${desc}${tier}${probe}`)
          }
        }
        return [{ type: 'text' as const, text: `Registered access profiles (${value.total}):\n${lines.join('\n')}` }]
      },
    },
    async execute(args: { help?: boolean }): Promise<ListAccessResult> {
      // Same discipline as the shell tools: resolve the seam per call through
      // ctx.get, never a static inject, never cached.
      const opsAccess = ctx.get('opsAccess') as OpsAccess | undefined
      if (!opsAccess) {
        throw new Error('ops-access service unavailable — is the ops-access plugin mounted in this preset?')
      }
      if (args.help) {
        return { groups: [], total: 0, help: opsAccess.help() }
      }
      const entries = await opsAccess.listAll()
      const byKind = new Map<string, ListedProfile[]>()
      for (const e of entries) {
        let bucket = byKind.get(e.kind)
        if (!bucket) byKind.set(e.kind, bucket = [])
        bucket.push(toListedProfile(e))
      }
      const groups = [...byKind.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, kindProfiles]) => ({ kind, profiles: kindProfiles }))
      return { groups, total: entries.length }
    },
  })))
}
