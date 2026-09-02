/**
 * Type definitions for the ops shell tool factory.
 *
 * Types only — every runtime value (the credential token machinery, the
 * output contract, the factory itself) lives in index.ts.
 *
 * @module @elinpf/dsh-ops-shell-tool
 */

import type { AccessAgent } from '@elinpf/dsh-ops-access'
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
  /**
   * Per-call shell timeout in ms (default 30000). Deployment-varying: slow
   * batch operations and distant clusters legitimately need more, and the
   * kill note tells the model exactly which ceiling it hit.
   */
  timeoutMs?: number
  /**
   * Known-noise stderr line patterns: any captured stderr line matching one
   * of these regexes is dropped from the result. For warnings the CLI prints
   * on every call that carry no information (e.g. ceph's missing-default-
   * keyring lines when credentials arrive via --keyring). Keep them exact —
   * every other stderr line passes through verbatim. Applied after
   * credential scrubbing. Use plain (non-global) regexes.
   */
  stderrNoise?: RegExp[]
}

/**
 * Mints a credential display token for one resolved profile field and
 * registers the field's value for execution-time substitution and output
 * scrubbing. Throws when the field is absent or not a non-empty string —
 * ref() exists for credential file fields, not optional inline values.
 */
export type CredentialRef = (field: string) => string

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
