/**
 * Environment inventory tool plugin (preset plane).
 *
 * Registers the model-facing `environment` tool (overview / show / refresh /
 * help) on top of the ticket-01 scanner core. The tool resolves the
 * ops-access seam per call via ctx.get — never a static inject, never
 * cached — so it must be mounted in the same isolate realm as opsAccess
 * (the `ops-access-registry` group in ops-preset.yml). The one-line
 * methodology section lives in the `./prompt` subpath plugin, mounted with
 * the prompt-channel consumers.
 *
 * apply() only registers the tool: nothing scans at session start. Scans
 * happen on explicit refresh, or on a read whose oldest section is past
 * the TTL.
 *
 * @module @deepseek-ai/dsh-ops-tool-environment
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_USER_RULES_FILE } from './classify.js'
import { DEFAULT_INVENTORY_FILE } from './inventory.js'
import { createEnvironmentTool } from './tool.js'
import type { EnvironmentToolConfig } from './tool.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-environment'

export const inject = ['tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config: z<EnvironmentToolConfig> = z.object({
  inventoryFile: z.string().default(DEFAULT_INVENTORY_FILE),
  rulesFile: z.string().default(DEFAULT_USER_RULES_FILE),
  ttlMinutes: z.number().default(60),
})

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: EnvironmentToolConfig): void {
  ctx.effect(() => ctx.tools.register(createEnvironmentTool(ctx, config)))
}

// ── Scanner-core re-exports (ticket 01 API surface) ─────────────────────────

export type {
  ClassifiedWorkload,
  ClusterInventory,
  ClusterScan,
  MiddlewareInstance,
  MonitoringStatus,
  PromTarget,
  RelationEdge,
  ResourceRef,
  ScannedConfigMap,
  ScannedIngress,
  ScannedSecret,
  ScannedService,
  ScannedWorkload,
} from './types.js'

export {
  builtinRules,
  classifySignals,
  classifyWorkload,
  DEFAULT_USER_RULES_FILE,
  expandHome,
  isMiddlewareType,
  loadUserRules,
} from './classify.js'
export type { ClassificationRule, ClassifyInput } from './classify.js'

export {
  defaultExec,
  ScanError,
  SCAN_TIMEOUT_MS,
  scanCluster,
  scrubKubeconfigPath,
} from './scanner.js'
export type { ExecFn, ScanClusterInput } from './scanner.js'

export { buildRelations, findServiceAddresses } from './relations.js'
export type { BuildRelationsInput } from './relations.js'

export {
  findPrometheusService,
  matchTargetsToWorkloads,
  parseActiveTargets,
  scrapePrometheusTargets,
} from './prometheus.js'
export type { PortForwardProcess, ScrapeOptions, SpawnFn } from './prometheus.js'

export {
  buildClusterInventory,
  DEFAULT_INVENTORY_FILE,
  readInventory,
  refreshInventory,
} from './inventory.js'
export type {
  EnvironmentInventory,
  InventorySection,
  RefreshOptions,
  RefreshTarget,
} from './inventory.js'

export { createEnvironmentTool } from './tool.js'
export type {
  ClusterDetail,
  ClusterSummary,
  DisplayEdge,
  EnvironmentToolConfig,
  EnvironmentToolDeps,
  EnvironmentToolResult,
  RefreshResultEntry,
  UnknownWorkload,
} from './tool.js'

export { HELP_POINTER, HELP_TEXT, STATIC_PROMPT, TOOL_DESCRIPTION } from './doctrine.js'
