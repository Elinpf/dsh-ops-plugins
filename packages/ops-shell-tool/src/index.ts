/**
 * Ops shell tool factory.
 *
 * One home for the boilerplate every ops-access consumer tool shares:
 * the result shape `{ exitCode, stdout, stderr, command, error? }`, its
 * output schema, the render function, and the execute template (resolve the
 * profile per call through `ctx.get('opsAccess')` — never a static inject,
 * never cached — assemble the command, run it through `ctx.shell` with a
 * fixed 30s timeout, normalize a signal-killed exitCode to -1, pass errors
 * through verbatim).
 *
 * A consumer package keeps only its identity: tool name, the kind it
 * resolves, and how to assemble the command from profile fields.
 *
 * @module @deepseek-ai/dsh-ops-shell-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OpsAccess } from '@deepseek-ai/dsh-ops-access'
// Type-only import: pulls in the `ctx.shell: ShellExecutor` augmentation and
// the ShellExecRequest/ShellRunResult shapes we run against.
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'

// ── Result shape (the one definition every consumer shares) ─────────────────

/** Shell tool result — the standard shape for ops command tools. */
export interface ShellToolResult {
  exitCode: number
  stdout: string
  stderr: string
  command: string
  error?: string
}

// ── Spec ─────────────────────────────────────────────────────────────────────

/** Everything a consumer tool must supply; the factory owns the rest. */
export interface ProfiledShellToolSpec {
  /** Tool name as the model sees it (e.g. 'kubectl', 'ceph', 'ssh'). */
  name: string
  /** ops-access kind to resolve (e.g. 'k8s', 'ceph', 'ssh'). */
  kind: string
  /** Name of the profile-name parameter (e.g. 'cluster', 'host'). */
  targetParam: string
  /** Tool description. */
  description: string
  /** Description for the profile-name parameter. */
  targetParamDescription: string
  /** Description for the command parameter. */
  commandDescription: string
  /** Assemble the full shell command from resolved profile fields + the model's command arg. */
  buildCommand: (fields: Record<string, unknown>, command: string) => string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return String((e as Error | null)?.message || e)
}

/** The shared output contract: schema + render, both pure. */
const output = {
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
  render: (_args: unknown, value: ShellToolResult) => {
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
} as const

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Register a profiled shell tool on `ctx.tools`, disposed with the plugin's
 * fiber. The caller's plugin must declare `inject = ['shell', 'tools']`.
 */
export function registerProfiledShellTool(ctx: Context, spec: ProfiledShellToolSpec): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: {
      [spec.targetParam]: { type: 'string', required: true, description: spec.targetParamDescription },
      command: { type: 'string', required: true, description: spec.commandDescription },
    },
    output,
    async execute(args: Record<string, unknown>, exec: { signal?: ShellExecRequest['signal'] }): Promise<ShellToolResult> {
      let fullCommand = ''
      try {
        // Resolve the seam per call through ctx.get: the preset mounts the
        // group concurrently, so 'opsAccess' must not be a static inject
        // (deadlock risk against the definition row), and by tool-call time
        // the service is long since provided. Same discipline as the
        // registry file itself: resolve per operation, cache nothing.
        const opsAccess = ctx.get('opsAccess') as OpsAccess | undefined
        if (!opsAccess) {
          const message = 'ops-access service unavailable — is the ops-access plugin mounted in this preset?'
          return { error: message, exitCode: -1, stdout: '', stderr: message, command: '' }
        }
        const profile = await opsAccess.resolve(spec.kind, args[spec.targetParam] as string)
        fullCommand = spec.buildCommand(profile.fields, args.command as string)
        const request: ShellExecRequest = { command: fullCommand, timeoutMs: 30000, signal: exec.signal }
        const resolved = ctx.shell.resolve(request)
        const result = await ctx.shell.run(resolved)
        // exitCode is null when the process died from a signal — normalize to -1.
        return { exitCode: result.exitCode ?? -1, stdout: result.stdout.text, stderr: result.stderr.text, command: fullCommand }
      } catch (e) {
        // Unknown profile names land here too — resolve's message already
        // lists the available names, so pass it through verbatim.
        const message = errorMessage(e)
        return { error: message, exitCode: -1, stdout: '', stderr: message, command: fullCommand }
      }
    },
  })))
}
