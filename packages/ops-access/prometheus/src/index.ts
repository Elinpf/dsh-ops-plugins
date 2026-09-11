/**
 * Ops access provider for Prometheus.
 *
 * Validates `prometheus` registry entries (`{ url, token? }`). The URL is
 * plain connection metadata and may surface in tool output; `token` is a
 * fileField — the admin UI / register_access accept token CONTENT, core
 * writes it to a managed file under ~/.dsh-ops/credentials/ and stores the
 * path, so the token itself never sits in the registry, logs, or model
 * context. The provider expands ~ in the token path for the tool's read.
 *
 * No capability probe: the Prometheus HTTP API is read-only by nature
 * (query/query_range), so there is no ro/rw distinction to verify — both
 * tiers serve the same connection parameters.
 *
 * @module @elinpf/dsh-ops-access-prometheus
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccessProvider } from '@elinpf/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@elinpf/dsh-ops-access'
import type { PrometheusEntry } from './types.js'

// Pure types live in types.ts (zero runtime code); re-exported here so
// existing `from './index.js'` type imports keep working.
export type { PrometheusEntry } from './types.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-prometheus'

export const inject: string[] = []

export const Config = z.object({})

// ── Provider ─────────────────────────────────────────────────────────────────

/** Zod schema for one prometheus registry entry (excluding name and envelope fields). */
export const entrySchema = zod.object({
  url: zod.url({ protocol: /^https?$/, error: 'url must be a valid http(s) URL (e.g. http://prometheus.monitoring:9090)' }),
  token: zod.string().optional(),
})

export const provider: AccessProvider = {
  kind: 'prometheus',
  schema: entrySchema,
  fieldsDoc: 'url: base URL of the Prometheus server (http(s)); token: optional bearer-token content (paste the token — it is stored as a managed file, the registry keeps only the path)',
  fileFields: ['token'],
  knownLimits: 'Prometheus HTTP API is read-only by nature (query/query_range); this profile carries no k8s permissions — pair it with the k8s profile of the same cluster',
  process(entry) {
    const { url, token } = entry as PrometheusEntry
    // Strip trailing slashes so the tool can append /api/v1/... cleanly.
    const fields: Record<string, unknown> = { url: url.replace(/\/+$/, '') }
    if (token !== undefined) fields.token = expandHome(token)
    return fields
  },
  // A pasted token must be a single line: it lands in an Authorization
  // header, where an interior newline is an invalid-character failure at
  // request time. Same discipline as the ssh password field.
  normalizeTrailingNewline: true,
  validateContent(field, content) {
    if (field !== 'token') return null
    const body = content.endsWith('\n') ? content.slice(0, -1) : content
    if (body.includes('\n') || body.includes('\r')) {
      return 'a bearer token must be a single line — it is sent verbatim in the Authorization header'
    }
    return null
  },
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  registerAccessProvider(ctx, provider)
}
