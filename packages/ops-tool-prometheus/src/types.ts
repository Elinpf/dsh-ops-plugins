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

/**
 * The suite-standard tool result shape — identical to ShellToolResult in
 * @elinpf/dsh-ops-shell-tool. Duplicated here (with the output schema/render)
 * because this tool speaks HTTP, not shell: it does not go through
 * registerProfiledShellTool, and ops-shell-tool does not export the contract
 * separately.
 */
export interface PrometheusToolResult {
  exitCode: number
  stdout: string
  stderr: string
  command: string
  error?: string
}
