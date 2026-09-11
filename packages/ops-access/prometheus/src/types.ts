/**
 * Type definitions for the ops-access-prometheus provider plugin.
 *
 * Types only — no runtime code lives here. Provider values (schema, plugin
 * apply) stay in index.ts.
 *
 * @module @elinpf/dsh-ops-access-prometheus
 */

/** One prometheus registry entry (excluding the registry key and envelope fields). */
export interface PrometheusEntry {
  /** Base URL of the Prometheus server, http(s) only (e.g. https://prometheus.monitoring:9090). */
  url: string
  /**
   * Path to a file holding the bearer token (optional). Declared in
   * fileFields: the admin UI / register_access accept token CONTENT, core
   * writes it to a managed 0600 file and stores the path. The tool reads the
   * file per call; the token itself never sits in the registry.
   */
  token?: string
}
