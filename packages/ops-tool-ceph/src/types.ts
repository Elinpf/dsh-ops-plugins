/**
 * Type definitions for the ops-tool-ceph plugin.
 *
 * Types only — no runtime values live here (not even consts), so importing
 * this module never pulls in plugin code.
 *
 * @module @deepseek-ai/dsh-ops-tool-ceph
 */

/**
 * Resolved configuration of the ops-tool-ceph plugin (post-schema defaults).
 */
export interface CephToolConfig {
  /** Per-call shell timeout for ceph runs (ms). Slow clusters may need more. */
  timeoutMs: number
}
