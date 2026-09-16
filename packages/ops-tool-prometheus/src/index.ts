/**
 * Ops prometheus tool consumer.
 *
 * The `prometheus` tool: resolves a `prometheus` profile through the
 * ops-access seam and runs a PromQL query directly against the Prometheus
 * HTTP API (GET /api/v1/query or /api/v1/query_range) — no ctx.shell, no
 * curl heredocs. When the profile carries a token fileField, the file is
 * read per call and sent as `Authorization: Bearer`; the token itself never
 * reaches the result, the displayed command, or any error text (every
 * returned string is scrubbed against it defensively).
 *
 * The result shape `{ exitCode, stdout, stderr, command, error? }` and the
 * output schema/render come from `shellToolOutput`/`ShellToolResult` in
 * ops-shell-tool — the suite-standard contract, reused (that factory wraps
 * ctx.shell commands, which this tool is not, but the contract stands alone).
 *
 * @module @elinpf/dsh-ops-tool-prometheus
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import type { OpsAccess } from '@elinpf/dsh-ops-access'
import type { ShellToolResult } from '@elinpf/dsh-ops-shell-tool'
import { shellToolOutput } from '@elinpf/dsh-ops-shell-tool'
import type { PrometheusToolConfig } from './types.js'

export type { PrometheusToolConfig } from './types.js'
export type { ShellToolResult as PrometheusToolResult } from '@elinpf/dsh-ops-shell-tool'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-tool-prometheus'

export const inject = ['tools']

// ── Config ───────────────────────────────────────────────────────────────────

export const Config: z<PrometheusToolConfig> = z.object({
  /** Per-call HTTP timeout for Prometheus queries (ms). Slow queries may need more. */
  timeoutMs: z.number().default(30000),
})

// ── Output contract: the ops-shell-tool one, shared ──────────────────────────

const output = shellToolOutput

// ── Formatting ───────────────────────────────────────────────────────────────

/** Hard caps guarding the model's context against a fat range query. */
const MAX_SERIES = 100
const MAX_POINTS_PER_SERIES = 50
/** ~100KB — stdout beyond this is cut and noted. */
const MAX_STDOUT_CHARS = 100 * 1024

type PromValue = [number, string]

interface PromSeries {
  metric: Record<string, string>
  value?: PromValue
  values?: PromValue[]
}

/** `up{instance="x",job="y"}` — the __name__ label leads, the rest sort-free. */
export function metricToString(metric: Record<string, string>): string {
  const name = metric.__name__ ?? ''
  const labels = Object.entries(metric)
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')
  if (labels === '') return name || '{}'
  return `${name}{${labels}}`
}

/** Prometheus timestamps are unix seconds (possibly fractional). */
function iso(ts: number): string {
  return new Date(ts * 1000).toISOString()
}

function formatVector(result: PromSeries[]): string {
  if (result.length === 0) return 'empty result — the query matched no series at that time'
  const shown = result.slice(0, MAX_SERIES)
  const lines = shown.map((s) => `${metricToString(s.metric)} = ${s.value?.[1]} @ ${iso(s.value?.[0] ?? 0)}`)
  if (result.length > shown.length) {
    lines.push(`(+${result.length - shown.length} more series omitted — narrow the query with more label matchers)`)
  }
  return lines.join('\n')
}

function formatScalar(result: PromValue): string {
  return `${result[1]} @ ${iso(result[0])}`
}

/**
 * Evenly sample `values` down to MAX_POINTS_PER_SERIES, always keeping the
 * first and last point — the shape of a spike survives sampling.
 */
function samplePoints(values: PromValue[]): { points: PromValue[], sampled: boolean } {
  if (values.length <= MAX_POINTS_PER_SERIES) return { points: values, sampled: false }
  const points: PromValue[] = []
  for (let i = 0; i < MAX_POINTS_PER_SERIES; i++) {
    points.push(values[Math.floor(i * (values.length - 1) / (MAX_POINTS_PER_SERIES - 1))])
  }
  return { points, sampled: true }
}

function formatMatrix(result: PromSeries[]): string {
  if (result.length === 0) return 'empty result — the query matched no series in that range'
  const shown = result.slice(0, MAX_SERIES)
  const blocks = shown.map((s) => {
    const values = s.values ?? []
    const { points, sampled } = samplePoints(values)
    const header = `${metricToString(s.metric)} — ${values.length} points${sampled ? `, showing ${points.length} evenly sampled` : ''}`
    return [header, ...points.map(([ts, v]) => `  ${iso(ts)}  ${v}`)].join('\n')
  })
  if (result.length > shown.length) {
    blocks.push(`(+${result.length - shown.length} more series omitted — narrow the query with more label matchers)`)
  }
  return blocks.join('\n\n')
}

/** Format a successful Prometheus response body by its resultType. */
export function formatResult(data: { resultType?: string, result?: unknown }): string {
  switch (data.resultType) {
    case 'vector': return formatVector((data.result ?? []) as PromSeries[])
    case 'matrix': return formatMatrix((data.result ?? []) as PromSeries[])
    case 'scalar':
    case 'string': return formatScalar(data.result as PromValue)
    default: return `unsupported resultType "${String(data.resultType)}" — raw result:\n${JSON.stringify(data.result ?? null, null, 2)}`
  }
}

/** Cut stdout at ~100KB with an explicit note — never a silent truncation. */
export function truncateStdout(text: string): string {
  if (text.length <= MAX_STDOUT_CHARS) return text
  return text.slice(0, MAX_STDOUT_CHARS)
    + `\n... [truncated: the result exceeded ${Math.round(MAX_STDOUT_CHARS / 1024)}KB — narrow the query (more label matchers), shorten the range, or raise the step]`
}

/** Single-quote a value for the display command (display only, never executed). */
function quoteArg(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

// ── Tool ─────────────────────────────────────────────────────────────────────

/** Injectable fetch (tests); defaults to the global fetch. */
export interface PrometheusToolDeps {
  fetchFn?: typeof fetch
}

function errorMessage(e: unknown): string {
  return String((e as Error | null)?.message || e)
}

export function createPrometheusTool(ctx: Context, config: PrometheusToolConfig, deps: PrometheusToolDeps = {}) {
  const fetchFn = deps.fetchFn ?? fetch
  return defineTool({
    name: 'prometheus',
    description: 'Query a Prometheus server with PromQL over its HTTP API: an instant query (optionally at `time`), or a range query when start+end+step are all given. Resolves the server URL and optional bearer token from a registered `prometheus` profile (see list_access). The API is read-only. Prefer this over hand-rolled curl: credentials, encoding, and timeouts are handled.',
    parameters: {
      cluster: { type: 'string', required: true, description: 'Prometheus profile name (kind `prometheus`; a `prometheus/` prefix is tolerated). Use list_access to see options.' },
      query: { type: 'string', required: true, description: 'The PromQL expression, e.g. `rate(http_requests_total{job="api"}[5m])`.' },
      time: { type: 'string', description: 'Instant query evaluation time: RFC3339 or unix seconds. Defaults to now. Mutually exclusive with start/end/step.' },
      start: { type: 'string', description: 'Range query start (RFC3339 or unix seconds). Requires end and step.' },
      end: { type: 'string', description: 'Range query end (RFC3339 or unix seconds). Requires start and step.' },
      step: { type: 'string', description: 'Range query resolution step, e.g. "15s", "1m". Requires start and end.' },
      timeoutSec: { type: 'number', description: 'Optional per-call timeout in seconds (default 30, max 600). Use only for a query you KNOW is slow (a wide range over many series) — a longer wait does not fix an unreachable server.' },
      tier: { type: 'string', enum: ['ro', 'rw'], description: 'Credential tier for THIS call. Omit = decided by the grant. "ro" = deliberate downgrade under an rw grant (declare it for pure queries). "rw" = require the write tier; fails loudly without a session grant and points at request_access.' },
    },
    output,
    async execute(args, exec): Promise<ShellToolResult> {
      const cluster = args.cluster
      const query = args.query
      const time = args.time
      const start = args.start
      const end = args.end
      const step = args.step

      const fail = (message: string, command = ''): ShellToolResult =>
        ({ error: message, exitCode: -1, stdout: '', stderr: message, command })

      // Argument shape first — cheap, side-effect free, and the teaching
      // message is most useful BEFORE a credential resolve has happened.
      const rangeArgs = [start, end, step].filter((v) => v !== undefined).length
      if (time !== undefined && rangeArgs > 0) {
        return fail('time is mutually exclusive with start/end/step — an instant query uses time (or neither, for now); a range query uses start+end+step')
      }
      if (rangeArgs > 0 && rangeArgs < 3) {
        return fail('a range query needs ALL of start, end and step (e.g. step "15s") — got only ' + rangeArgs + ' of them')
      }
      const isRange = rangeArgs === 3

      const display = `prometheus ${cluster} query=${quoteArg(query)}`
        + (time !== undefined ? ` time=${time}` : '')
        + (isRange ? ` start=${start} end=${end} step=${step}` : '')

      let token: string | undefined
      /** Defensive: the token must never reach model-visible output. */
      const scrub = (text: string): string =>
        token !== undefined && token.length >= 8 ? text.split(token).join('<token>') : text

      let command = display
      try {
        // Resolve the seam per call through ctx.get — never a static inject,
        // never cached. Same discipline as the shell-tool factory.
        const opsAccess = ctx.get('opsAccess') as OpsAccess | undefined
        if (!opsAccess) {
          return fail('ops-access service unavailable — is the ops-access plugin mounted in this preset?', display)
        }
        // Pass the caller agent through so the access gate (if mounted) can
        // key grants on the session id. Core tolerates a `prometheus/` prefix
        // on the name. An explicit tier arg is the per-call declaration
        // ('ro' = deliberate downgrade; 'rw' = fail loudly when ungranted).
        const tierArg = args.tier === 'ro' || args.tier === 'rw' ? args.tier : undefined
        const profile = await opsAccess.resolve('prometheus', cluster, exec.agent, tierArg ? { tier: tierArg } : undefined)
        const baseUrl = String(profile.fields.url ?? '')
        const endpoint = isRange ? '/api/v1/query_range' : '/api/v1/query'
        command = `${display} @ ${baseUrl}${endpoint}`

        // The token field is a PATH to a managed file (fileField). A read
        // failure is reported without the path — credential paths never
        // reach the model (same discipline as the shell-tool's ref tokens).
        if (typeof profile.fields.token === 'string' && profile.fields.token !== '') {
          try {
            token = (await readFile(profile.fields.token, 'utf8')).trim()
          } catch {
            return fail(`the bearer token file of profile "${profile.name}" could not be read — re-register the token via register_access or the admin UI`, command)
          }
        }

        const u = new URL(baseUrl + endpoint)
        u.searchParams.set('query', query)
        if (isRange) {
          u.searchParams.set('start', start!)
          u.searchParams.set('end', end!)
          u.searchParams.set('step', step!)
        } else if (time !== undefined) {
          u.searchParams.set('time', time)
        }

        let timeoutMs = config.timeoutMs
        const override = args.timeoutSec
        if (typeof override === 'number' && Number.isFinite(override) && override >= 1 && override <= 600) {
          timeoutMs = Math.round(override * 1000)
        }
        const signals = [AbortSignal.timeout(timeoutMs)]
        if (exec.signal) signals.push(exec.signal)
        // Headers carry the token; they are never logged or echoed — only
        // the URL (plain connection metadata) appears in `command`.
        const headers: Record<string, string> = token !== undefined ? { authorization: `Bearer ${token}` } : {}

        const response = await fetchFn(u.toString(), { headers, signal: AbortSignal.any(signals) })
        const text = await response.text()
        let body: { status?: string, data?: { resultType?: string, result?: unknown }, errorType?: string, error?: string, warnings?: string[] } | undefined
        try { body = JSON.parse(text) } catch { body = undefined }

        // A PromQL rejection arrives as status:'error' (usually with HTTP
        // 4xx) — that is the SERVER's answer, so it is exitCode 1, not -1.
        if (body?.status === 'error') {
          const detail = `${body.errorType ?? 'error'}: ${body.error ?? 'unknown error'}`
          return { exitCode: 1, stdout: '', stderr: scrub(detail), command, error: scrub(detail) }
        }
        if (!response.ok) {
          const message = `the Prometheus server answered HTTP ${response.status} ${response.statusText}`.trimEnd()
          return { ...fail(scrub(message), command), stderr: scrub(text.slice(0, 2000)) }
        }
        if (body?.status !== 'success') {
          return fail(scrub(`unexpected response from the Prometheus server (not a prometheus API envelope, ${text.length} bytes) — is ${baseUrl} really a Prometheus?`), command)
        }
        const stdout = truncateStdout(scrub(formatResult(body.data ?? {})))
        const stderr = (body.warnings ?? []).map((w) => `warning: ${scrub(w)}`).join('\n')
        return { exitCode: 0, stdout, stderr, command }
      } catch (e) {
        const err = e as { name?: string, message?: string, cause?: { message?: string } }
        let message: string
        if (err.name === 'TimeoutError') {
          message = `timed out — the Prometheus server did not answer within the tool timeout. For a known-slow query pass timeoutSec (max 600); for a wide range query raise the step or narrow the selector instead`
        } else if (err.name === 'AbortError') {
          message = 'aborted: the caller cancelled this query before it finished.'
        } else {
          // fetch network failures (TypeError 'fetch failed' + cause) — the
          // message carries no headers, and the URL is not secret.
          const cause = err.cause?.message ? ` (${err.cause.message})` : ''
          message = `connection to the Prometheus server failed: ${errorMessage(e)}${cause}`
        }
        return fail(scrub(message), command)
      }
    },
  })
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: PrometheusToolConfig): void {
  ctx.effect(() => ctx.tools.register(createPrometheusTool(ctx, config)))
}
