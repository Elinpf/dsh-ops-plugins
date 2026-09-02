/**
 * Type definitions for the ops-tool-ssh plugin.
 *
 * Types only — no runtime values live here.
 *
 * @module @elinpf/dsh-ops-tool-ssh
 */

/**
 * Resolved plugin config (post-Config-schema defaults).
 */
export interface SshToolConfig {
  /** Per-call shell timeout for ssh runs (ms). */
  timeoutMs: number
  /** ssh -o ConnectTimeout value (seconds) — how long to wait for the TCP handshake. */
  connectTimeoutSeconds: number
}
