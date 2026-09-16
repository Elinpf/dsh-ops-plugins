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
   * When true the tool gains an optional `timeoutSec` parameter (1–600s) so
   * the model can extend the per-call ceiling for one known-slow command
   * (e.g. `rados ls` on a large pool) instead of being hard-killed at the
   * configured timeoutMs. Absent/0/out-of-range values fall back to
   * timeoutMs.
   */
  perCallTimeout?: boolean
  /**
   * When true, a command containing shell composition operators (`;`, `&&`,
   * `||`, backticks, `$(`, newlines) is rejected with a teaching error
   * BEFORE execution: everything after such an operator runs as a NEW local
   * command without the tool's binary prefix and credentials, which the
   * model reads as a mysterious 'get: command not found' and misattributes
   * to the cluster (it did, repeatedly, 2026-09-10). A single `|` pipe is
   * still allowed — it filters the wrapped command's output locally. Leave
   * unset for tools whose command legitimately contains composition
   * (ops-tool-ssh passes the whole string to the REMOTE shell).
   */
  rejectShellComposition?: boolean
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
 * consumers stay identity-only and need no changes. The agent's `session`
 * (opaque here) is forwarded to the sandboxPolicy service so a confining
 * shell executor sandboxes against the CALLING session's workspace, not the
 * deployment fallback root.
 */
export interface ShellToolExec {
  signal?: ShellExecRequest['signal']
  agent?: AccessAgent & { session?: unknown }
}
