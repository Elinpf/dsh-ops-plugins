/**
 * Type definitions for the ops-access SSH provider.
 *
 * @module @elinpf/dsh-ops-access-ssh
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
  /**
   * Login user. Optional on the entry when `cred` is set — the referenced
   * credential's user applies; a user set HERE overrides it for this host.
   * The resolved profile must end up with a user from one of the two.
   */
  user?: string
  /** Path to the private key file (`~` is expanded by the provider). */
  key?: string
  /** Path to a password file (0600, first line is the password) for sshpass. */
  password?: string
  /**
   * Reference to an `ssh-cred` entry holding the shared credential (key or
   * password, and optionally the default user). Fields set on the host entry
   * itself override the referenced credential's.
   */
  cred?: string
  /** SSH port (default 22). */
  port?: number
}

/**
 * One ssh-cred registry entry: a reusable SSH credential, registered once and
 * referenced by any number of ssh host entries via their `cred` field.
 * Mirror of `credEntrySchema` in index.ts — keep the two in sync.
 */
export interface SshCredEntry {
  /** Default login user for hosts referencing this credential. */
  user?: string
  /** Path to the private key file (`~` is expanded by the provider). */
  key?: string
  /** Path to a password file (0600, first line is the password) for sshpass. */
  password?: string
}

/** Plugin configuration (see `Config` in index.ts). */
export interface SshProviderConfig {
  /** Save-time validation: timeout for the `ssh-keygen -y` parse (ms). */
  validateTimeoutMs: number
}
