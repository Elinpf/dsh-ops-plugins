/**
 * Type definitions for the ops-tool-prometheus plugin.
 *
 * Types only — no runtime values live here (not even consts), so importing
 * this module never pulls in plugin code.
 *
 * @module @elinpf/dsh-ops-tool-prometheus
 */

/**
 * Resolved configuration of the ops-tool-prometheus plugin (post-schema defaults).
 */
export interface PrometheusToolConfig {
  /** Per-call HTTP timeout for Prometheus queries (ms). Slow queries may need more. */
  timeoutMs: number
}
