/**
 * Type definitions for the ops-access SSH provider.
 *
 * @module @deepseek-ai/dsh-ops-access-ssh
 */

/**
 * One ssh registry entry (excluding name and the envelope fields).
 *
 * This is the hand-written mirror of the runtime `entrySchema` in index.ts —
 * keep the two in sync when fields change.
 */
export interface SshEntry {
  /** Hostname or IP of the target. */
  host: string
  /** Login user. */
  user: string
  /** Path to the private key file (`~` is expanded by the provider). */
  key?: string
  /** SSH port (default 22). */
  port?: number
}

/** Plugin configuration (see `Config` in index.ts). */
export interface SshProviderConfig {
  /** Save-time validation: timeout for the `ssh-keygen -y` parse (ms). */
  validateTimeoutMs: number
}
