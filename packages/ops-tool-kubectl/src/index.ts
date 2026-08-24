/**
 * Ops kubectl tool consumer.
 *
 * Registers two model-facing tools on top of the ops-access capability seam:
 *
 * - `kubectl` — resolves a `k8s` profile through the ops-access seam
 *   (`ctx.get('opsAccess')` at call time; never a static inject — see the
 *   comment in execute)
 *   then runs the command through the host shell service (`ctx.shell`) with a
 *   fixed 30s timeout. The result shape and render format formalize the old
 *   k8s-plugin.js prototype: `{ exitCode, stdout, stderr, command, error? }`.
 * - `list_access` — groups `ctx.opsAccess.list()` by kind. Envelope fields
 *   only (kind/name/description/environment); profile `fields` (paths,
 *   connection params) never appear in this tool's output.
 *
 * @module @deepseek-ai/dsh-ops-kubectl
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AccessProfile, OpsAccess } from '@deepseek-ai/dsh-ops-access'
// Type-only import: pulls in the `ctx.shell: ShellExecutor` augmentation and
// the ShellExecRequest/ShellExecSpec/ShellRunResult shapes we run against.
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-kubectl'

export const inject = ['shell', 'tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config = z.object({})

// ── Result types ─────────────────────────────────────────────────────────────

/** kubectl tool result — mirrors the prototype's shape. */
interface KubectlResult {
  exitCode: number
  stdout: string
  stderr: string
  command: string
  error?: string
}

/** One list_access entry: envelope fields only, never `fields`. */
interface ListedProfile {
  name: string
  description?: string
  environment?: string
}

interface ListAccessResult {
  groups: Array<{ kind: string, profiles: ListedProfile[] }>
  total: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return String((e as Error | null)?.message || e)
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
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'kubectl',
    description: 'Execute a kubectl command on a specified K8s cluster. The plugin automatically injects the correct --kubeconfig path. Use list_access to see available cluster names.',
    parameters: {
      cluster: { type: 'string', required: true, description: 'K8s cluster profile name. Use list_access to see options.' },
      command: { type: 'string', required: true, description: 'kubectl subcommand WITHOUT the kubectl prefix. Examples: get pods -n default, describe node node-1' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'number', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          command: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      // Pure function of (args, value): same inputs, same text, no state touched.
      render: (_args, value) => {
        const parts: string[] = []
        if (value.command) parts.push(`$ ${value.command}`)
        if (value.stdout) parts.push(value.stdout)
        if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
        if (value.error) parts.push(`[error] ${value.error}`)
        if (value.exitCode !== 0 && value.exitCode !== undefined && value.exitCode !== null) {
          parts.push(`[exit code: ${value.exitCode}]`)
        }
        return [{ type: 'text' as const, text: parts.join('\n\n') || '(no output)' }]
      },
    },
    async execute(args, exec): Promise<KubectlResult> {
      let fullCommand = ''
      try {
        // Resolve the seam per call through ctx.get: the preset mounts this
        // group concurrently, so 'opsAccess' must not be a static inject
        // (deadlock risk against the definition row), and by tool-call time
        // the service is long since provided. Same discipline as the
        // registry file itself: resolve per operation, cache nothing.
        const opsAccess = ctx.get('opsAccess') as OpsAccess | undefined
        if (!opsAccess) {
          const message = 'ops-access service unavailable — is the ops-access plugin mounted in this preset?'
          return { error: message, exitCode: -1, stdout: '', stderr: message, command: '' }
        }
        const profile = await opsAccess.resolve('k8s', args.cluster)
        const kubeconfigPath = profile.fields.kubeconfigPath
        fullCommand = `kubectl --kubeconfig="${kubeconfigPath}" ${args.command}`
        const request: ShellExecRequest = { command: fullCommand, timeoutMs: 30000, signal: exec.signal }
        const spec = ctx.shell.resolve(request)
        const result = await ctx.shell.run(spec)
        // exitCode is null when the process died from a signal — normalize to -1.
        return { exitCode: result.exitCode ?? -1, stdout: result.stdout.text, stderr: result.stderr.text, command: fullCommand }
      } catch (e) {
        // Unknown cluster names land here too — resolve's message already lists
        // the available names, so pass it through verbatim.
        const message = errorMessage(e)
        return { error: message, exitCode: -1, stdout: '', stderr: message, command: fullCommand }
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_access',
    description: 'List all registered ops access profiles (e.g. K8s clusters), grouped by kind. Shows name, description, and environment only — no paths or connection details.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
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
    async execute(): Promise<ListAccessResult> {
      const opsAccess = ctx.get('opsAccess') as OpsAccess | undefined
      if (!opsAccess) {
        throw new Error('ops-access service unavailable — is the ops-access plugin mounted in this preset?')
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
