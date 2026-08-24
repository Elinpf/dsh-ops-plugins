/**
 * Ops kubectl tool consumer.
 *
 * Registers two model-facing tools on top of the ops-access capability seam:
 *
 * - `kubectl` — resolves a `k8s` profile and runs the command via ctx.shell,
 *   injecting the profile's --kubeconfig path. All shared machinery (result
 *   shape, output schema, render, execute template) lives in
 *   @deepseek-ai/dsh-ops-shell-tool.
 * - `list_access` — groups `ctx.opsAccess.list()` by kind. Envelope fields
 *   only (kind/name/description/environment); profile `fields` (paths,
 *   connection params) never appear in this tool's output.
 *
 * @module @deepseek-ai/dsh-ops-kubectl
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerProfiledShellTool } from '@deepseek-ai/dsh-ops-shell-tool'
import type { AccessProfile, OpsAccess } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-kubectl'

export const inject = ['shell', 'tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({})

// ── list_access types ────────────────────────────────────────────────────────

/** One list_access entry: envelope fields only, never `fields`. */
interface ListedProfile {
  name: string
  description?: string
  environment?: string
}

interface ListAccessResult {
  groups: Array<{ kind: string, profiles: ListedProfile[] }>
  total: number
  /** Present when called with help: true — the registry management doc. */
  help?: string
}

/** Strip a profile down to its envelope fields — `fields` never crosses into tool output. */
function toListedProfile(p: AccessProfile): ListedProfile {
  const listed: ListedProfile = { name: p.name }
  if (p.description !== undefined) listed.description = p.description
  if (p.environment !== undefined) listed.environment = p.environment
  return listed
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  registerProfiledShellTool(ctx, {
    name: 'kubectl',
    kind: 'k8s',
    targetParam: 'cluster',
    description: 'Execute a kubectl command on a specified K8s cluster. The plugin automatically injects the correct --kubeconfig path. Use list_access to see available cluster names.',
    targetParamDescription: 'K8s cluster profile name. Use list_access to see options.',
    commandDescription: 'kubectl subcommand WITHOUT the kubectl prefix. Examples: get pods -n default, describe node node-1',
    buildCommand(fields, command) {
      const { kubeconfigPath } = fields as { kubeconfigPath: string }
      return `kubectl --kubeconfig="${kubeconfigPath}" ${command}`
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
                      description: { type: 'string' },
                      environment: { type: 'string' },
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
            const env = p.environment ? ` [${p.environment}]` : ''
            const desc = p.description ? ` — ${p.description}` : ''
            lines.push(`- ${p.name}${env}${desc}`)
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
      const profiles = await opsAccess.list()
      const byKind = new Map<string, ListedProfile[]>()
      for (const p of profiles) {
        let bucket = byKind.get(p.kind)
        if (!bucket) byKind.set(p.kind, bucket = [])
        bucket.push(toListedProfile(p))
      }
      const groups = [...byKind.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, kindProfiles]) => ({ kind, profiles: kindProfiles }))
      return { groups, total: profiles.length }
    },
  })))
}
