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
 * Credential paths never reach the model or the event log. Consumers mark
 * file-bearing fields with the `ref()` helper, which emits a display token
 * `<id@tier:field>`; the factory substitutes the shell-quoted real value
 * only in the command handed to `ctx.shell`, and scrubs every occurrence
 * of a referenced value back to its token in the displayed command AND in
 * captured stdout/stderr (CLIs like kubectl print their --kubeconfig path
 * in error output). The model sees `kubectl --kubeconfig=<prod@rw:kubeconfigPath>`,
 * never `/root/.dsh-ops/credentials/...`.
 *
 * A consumer package keeps only its identity: tool name, the kind it
 * resolves, and how to assemble the command from profile fields.
 *
 * @module @deepseek-ai/dsh-ops-shell-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AccessAgent, OpsAccess } from '@deepseek-ai/dsh-ops-access'
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
  /**
   * Assemble the full shell command from resolved profile fields + the
   * model's command arg. Mark every file-bearing field with `ref(field)` —
   * it returns a display token `<id@tier:field>` that the factory swaps for
   * the shell-quoted real value at execution time and scrubs back out of all
   * captured output. Inline only non-secret values (flags, user@host, names).
   */
  buildCommand: (fields: Record<string, unknown>, command: string, ref: CredentialRef) => string
}

/**
 * Mints a credential display token for one resolved profile field and
 * registers the field's value for execution-time substitution and output
 * scrubbing. Throws when the field is absent or not a non-empty string —
 * ref() exists for credential file fields, not optional inline values.
 */
export type CredentialRef = (field: string) => string

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return String((e as Error | null)?.message || e)
}

/** Single-quote a value for safe shell embedding (the substitute for a ref token). */
function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

/** Per-call credential reference tokens: mint, substitute, and scrub. */
interface CredentialTokenSet {
  /** The ref() helper handed to buildCommand. */
  readonly ref: CredentialRef
  /** The command handed to ctx.shell: tokens swapped for quoted real values. */
  executable(displayCommand: string): string
  /**
   * Replace every occurrence of a referenced value with its token. Applied
   * to the display command (the model may paste a real path into its command
   * arg) and to captured stdout/stderr (CLI errors echo flag values). Values
   * shorter than 8 chars are skipped — they are never credential paths and
   * replacing them could garble ordinary output.
   */
  scrub(text: string): string
}

/**
 * Credential tokens minted per tool call: display token `<id@tier:field>` →
 * raw field value. The display command keeps tokens; the executed command
 * substitutes quoted values; captured output is scrubbed value → token so
 * credential paths never reach the model or the session event log — one
 * mechanism, shared by every consumer tool.
 */
function createCredentialTokens(profileName: string, tier: string, fields: Record<string, unknown>): CredentialTokenSet {
  const secrets = new Map<string, string>()
  const ref: CredentialRef = (field) => {
    const value = fields[field]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('ops-access: profile ' + profileName + ' field "' + field + '" is not a non-empty string — ref() is for credential file fields')
    }
    const token = '<' + profileName + '@' + tier + ':' + field + '>'
    secrets.set(token, value)
    return token
  }
  return {
    ref,
    executable(displayCommand) {
      let out = displayCommand
      for (const [token, value] of secrets) {
        out = out.split(token).join(shellQuote(value))
      }
      return out
    },
    scrub(text) {
      let out = text
      for (const [token, value] of secrets) {
        if (value.length >= 8) out = out.split(value).join(token)
      }
      return out
    },
  }
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

/**
 * The exec context the factory's execute runs under. Structurally a subset of
 * dsh's ToolRunContext: `signal` (required there, optional here for tests)
 * and the optional caller `agent`, whose `id` is the session the access gate
 * keys grants on. The factory passes `agent` straight through to resolve —
 * consumers stay identity-only and need no changes.
 */
export interface ShellToolExec {
  signal?: ShellExecRequest['signal']
  agent?: AccessAgent
}

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
    async execute(args: Record<string, unknown>, exec: ShellToolExec): Promise<ShellToolResult> {
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
        // Pass the caller agent through so the access gate (if mounted) can
        // key grants on the session id. Without a gate this arg is inert.
        const profile = await opsAccess.resolve(spec.kind, args[spec.targetParam] as string, exec.agent)
        // Mint per-call credential tokens: buildCommand marks file fields via
        // ref(); the display command (model-visible, logged) keeps the tokens,
        // only the executed command carries the real values.
        const tokens = createCredentialTokens(profile.name, profile.tier, profile.fields)
        fullCommand = tokens.scrub(spec.buildCommand(profile.fields, args.command as string, tokens.ref))
        const request: ShellExecRequest = { command: tokens.executable(fullCommand), timeoutMs: 30000, signal: exec.signal }
        const resolved = ctx.shell.resolve(request)
        const result = await ctx.shell.run(resolved)
        // exitCode is null when the process died from a signal — normalize to
        // -1. stdout/stderr are scrubbed value → token: CLIs echo credential
        // paths in errors, and the event log must never see them.
        return {
          exitCode: result.exitCode ?? -1,
          stdout: tokens.scrub(result.stdout.text),
          stderr: tokens.scrub(result.stderr.text),
          command: fullCommand,
        }
      } catch (e) {
        // Unknown profile names land here too — resolve's message already
        // lists the available names, so pass it through verbatim.
        const message = errorMessage(e)
        return { error: message, exitCode: -1, stdout: '', stderr: message, command: fullCommand }
      }
    },
  })))
}
