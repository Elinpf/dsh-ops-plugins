/**
 * Ops access capability seam.
 *
 * Owns the YAML credential registry file (default `~/.dsh-ops/access.yaml`)
 * and exposes `ctx.opsAccess`: a generic `resolve(kind, name)` / `list()`
 * entry plus a `register(provider)` surface for provider plugins. Providers
 * (one per credential kind) supply the zod schema for their entry shape and
 * an optional `process` step (e.g. `~` expansion); secret material never
 * leaves the filesystem — profiles carry only paths and connection params.
 *
 * The registry file is re-read, re-parsed, and re-validated on every call —
 * edits take effect immediately, nothing is cached.
 *
 * Registry format:
 *
 * ```yaml
 * version: 1
 * k8s:
 *   prod:
 *     kubeconfig: ~/.kube/prod.yaml
 *     description: 生产集群
 *     environment: prod
 * ```
 *
 * Every top-level section besides `version` is a kind; keys inside a section
 * are profile names. `description` and `environment` are envelope fields
 * understood here; everything else belongs to the provider schema.
 *
 * @module @deepseek-ai/dsh-ops-access
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import type { ZodType } from 'zod'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { formatAccessMention, parseAccessReferenceText } from './mention.js'
import type { ParsedAccessReference } from './mention.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access'

export const inject: string[] = []

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  /** Path to the YAML access registry; a leading `~` expands to $HOME. */
  registryFile: string
  /**
   * Path to the rw (read-write) credential registry. Same format and the same
   * per-call read/validate discipline as {@link registryFile}, but held
   * separately so its contents never appear in the agent-readable access.yaml.
   * Defaults to `~/.dsh-ops/access-rw.yaml`. Owned by core; the access gate
   * only decides ro/rw, it never sees these fields.
   */
  rwRegistryFile: string
}

export const Config: z<Config> = z.object({
  registryFile: z.string().default('~/.dsh-ops/access.yaml'),
  rwRegistryFile: z.string().default('~/.dsh-ops/access-rw.yaml'),
})

// ── Service contract ─────────────────────────────────────────────────────────

/** A credential-kind provider: the zod schema for its entries plus an optional processing step. */
export interface AccessProvider {
  /** Credential kind, matching the registry section name ('k8s' | 'ceph' | 'ssh' | ...). */
  kind: string
  /** Zod schema for one registry entry of this kind (excluding name and the envelope fields). */
  schema: ZodType
  /** Optional post-validation processing (e.g. `~` expansion). Input is the schema-validated entry. */
  process?(entry: unknown, name: string): Record<string, unknown>
  /**
   * One-line human doc of the entry's fields, surfaced by `help()` so the
   * agent can learn how to write a registry entry for this kind. Keep it to
   * the fields themselves, e.g. "kubeconfig: path to the kubeconfig file (~
   * is expanded)". The schema is the machine contract; this is its prose.
   */
  fieldsDoc?: string
}

/** A resolved access profile: envelope fields plus the provider-processed type-specific fields. */
export interface AccessProfile {
  kind: string
  name: string
  description?: string
  environment?: string
  /** Type-specific fields after provider schema validation and process. */
  fields: Record<string, unknown>
}

// ── Access gate (broker) ─────────────────────────────────────────────────────

/**
 * Minimal caller-agent identity consulted by the broker. dsh's `Agent` (whose
 * `id` is the session id) satisfies this structurally; core takes a narrow
 * dependency on purpose — the broker is a pure decision function and never
 * touches the rest of the agent.
 */
export interface AccessAgent {
  /** Session id (`exec.agent.id`). Grants are keyed by this. */
  readonly id: string
}

/**
 * A broker's decision for one resolve call.
 * - `'ro'` — serve the profile from the default registry (access.yaml)
 * - `'rw'` — serve the profile from the rw registry (access-rw.yaml)
 * - `{ deny }` — refuse; core throws the broker's message verbatim (the
 *   broker owns the guidance, e.g. pointing at `request_access`).
 */
export type AccessBrokerDecision = 'ro' | 'rw' | { deny: string }

/**
 * The pure decision function a gate registers. Receives only kind, profile
 * name, and the caller agent — never credential fields. Called by resolve
 * only when a broker is registered AND an agent context was supplied; absent
 * either, resolve behaves exactly as it does without a gate (ro).
 */
export type AccessBroker = (kind: string, name: string, agent: AccessAgent) => AccessBrokerDecision

/** The ops access handle exposed via ctx.get('opsAccess'). */
export interface OpsAccess {
  /** Register a credential-kind provider. Throws if the kind is already registered. Returns a disposer. */
  register(provider: AccessProvider): () => void
  /**
   * Register an access broker (the gate). At most one broker is active; a later
   * registration replaces an earlier one. Returns a disposer. Without a
   * registered broker, resolve is unchanged from the broker-less behavior.
   */
  registerBroker(broker: AccessBroker): () => void
  /**
   * Whether the rw registry has an entry for this profile — existence only,
   * never fields. The gate uses it to reject requests for profiles that have
   * no rw tier BEFORE bothering the human approver.
   */
  hasRwEntry(kind: string, name: string): Promise<boolean>
  /**
   * Resolve one profile by kind and name. Throws on unknown kind, unknown
   * name, or invalid entry. When a broker is registered and `agent` is
   * supplied, the broker decides whether the rw profile is served; otherwise
   * the ro profile (from `registryFile`) is served, byte-for-byte as before.
   */
  resolve(kind: string, name: string, agent?: AccessAgent): Promise<AccessProfile>
  /** List all profiles across all registered kinds. Sections without a registered provider are skipped. */
  list(): Promise<AccessProfile[]>
  /**
   * The registry management doc: file location, format, envelope fields, and
   * every registered kind's field doc. Progressive disclosure — the agent
   * pulls this when it needs to edit the registry; nothing sits in the
   * system prompt.
   */
  help(): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsAccess?: OpsAccess
  }
}

// ── Provider registration helper ─────────────────────────────────────────────

/**
 * Register a provider into the seam from a provider plugin's `apply()`. The
 * preset mounts sibling rows concurrently, so a static inject on 'opsAccess'
 * can deadlock the loader against the definition row — this defers through
 * `ctx.inject` and ties the registration to the plugin's effect lifecycle.
 * Provider packages should call this and nothing else.
 */
export function registerAccessProvider(ctx: Context, provider: AccessProvider): void {
  ctx.inject(['opsAccess'], (pctx: Context) => {
    pctx.effect(() => pctx.opsAccess!.register(provider))
  })
}

/**
 * Register an access broker (the gate) from the gate plugin's `apply()`. Same
 * deferred-mount discipline as {@link registerAccessProvider}: the preset
 * mounts sibling rows concurrently, so a static inject on 'opsAccess' can
 * deadlock the loader against the definition row — this defers through
 * `ctx.inject` and ties the registration to the plugin's effect lifecycle.
 */
export function registerAccessBroker(ctx: Context, broker: AccessBroker): void {
  ctx.inject(['opsAccess'], (pctx: Context) => {
    pctx.effect(() => pctx.opsAccess!.registerBroker(broker))
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Expand a leading `~` (or `~/`) to the user's home directory. */
export function expandHome(p: string): string {
  const home = process.env.HOME ?? os.homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p
}

/** Parsed registry: kind section → profile name → raw entry. */
type Registry = Record<string, Record<string, unknown>>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read and parse the registry file. Returns null when the file does not
 * exist so callers can pick their own discipline (list → empty, resolve →
 * error). Never includes raw file text in errors.
 */
async function loadRegistry(file: string): Promise<Registry | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null
    throw new Error(`ops-access: failed to read registry file ${file}: ${err?.message ?? err}`)
  }

  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (err: any) {
    // First line only — the yaml library appends a source snippet to its
    // messages, and raw registry text must not leak into errors.
    const summary = String(err?.message ?? err).split('\n')[0]
    throw new Error(`ops-access: failed to parse registry file ${file}: ${summary}`)
  }

  // An empty file parses to null — treat it as an empty registry.
  if (doc == null) return {}
  if (!isPlainObject(doc)) {
    throw new Error(`ops-access: registry file ${file} must contain a top-level mapping`)
  }

  const registry: Registry = {}
  for (const [kind, section] of Object.entries(doc)) {
    if (kind === 'version') continue
    if (!isPlainObject(section)) {
      throw new Error(`ops-access: section "${kind}" in registry file ${file} must be a mapping of profile names`)
    }
    registry[kind] = section
  }
  return registry
}

/** Validate one raw entry against the provider schema and build the profile. */
function buildProfile(provider: AccessProvider, kind: string, profileName: string, raw: unknown, file: string): AccessProfile {
  if (!isPlainObject(raw)) {
    throw new Error(`ops-access: entry ${kind}.${profileName} in registry file ${file} must be a mapping`)
  }
  const { description, environment, ...rest } = raw
  const result = provider.schema.safeParse(rest)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`ops-access: invalid entry ${kind}.${profileName} in registry file ${file}: ${issues}`)
  }
  const fields = provider.process
    ? provider.process(result.data, profileName)
    : result.data as Record<string, unknown>
  const profile: AccessProfile = { kind, name: profileName, fields }
  if (typeof description === 'string') profile.description = description
  if (typeof environment === 'string') profile.environment = environment
  return profile
}

// ── Mention injection (agent/pre-step) ──────────────────────────────────────

/**
 * Render the envelope context for referenced profiles. Envelope fields only —
 * fields (paths, connection params) never cross into model context, keeping
 * the structural secrecy discipline. Unknown profiles degrade to a note, not
 * an error: a stale mention must not block the step.
 */
async function renderAccessReferences(
  handle: OpsAccess,
  references: readonly ParsedAccessReference[],
): Promise<string> {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const ref of references) {
    const key = `${ref.kind}/${ref.name}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const profile = await handle.resolve(ref.kind, ref.name)
      const env = profile.environment ? ` [${profile.environment}]` : ''
      const desc = profile.description ? ` — ${profile.description}` : ''
      lines.push(`- ${key}${env}${desc}`)
    } catch {
      lines.push(`- ${key} — (not found in the access registry; run list_access to see available profiles)`)
    }
  }
  return `<referenced-access>\nThe user explicitly referenced these access profiles (use them with the matching tools):\n${lines.join('\n')}\n</referenced-access>`
}
// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const roFile = expandHome(config.registryFile)
  const rwFile = expandHome(config.rwRegistryFile)
  const providers = new Map<string, AccessProvider>()
  // At most one broker is active; a later registration replaces an earlier one.
  // The replaced broker's disposer is folded into the replacement's, so each
  // registration's effect cleanup runs exactly once even under replacement or
  // HMR unload — honoring the cordis effect-lifecycle discipline.
  let broker: AccessBroker | undefined
  let clearBroker: () => void = () => {}

  const handle: OpsAccess = {
    register(provider: AccessProvider): () => void {
      if (providers.has(provider.kind)) {
        throw new Error(`ops-access: provider for kind "${provider.kind}" is already registered`)
      }
      providers.set(provider.kind, provider)
      return () => { providers.delete(provider.kind) }
    },

    registerBroker(next: AccessBroker): () => void {
      // Replace the active broker: fold the previous disposer into this one so
      // the prior registration's cleanup still runs (once) under replacement
      // or HMR unload, and the guard prevents a stale disposer clobbering a
      // later broker.
      const prev = clearBroker
      broker = next
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        if (broker === next) {
          broker = undefined
          clearBroker = () => {}
        }
        prev()
      }
      clearBroker = dispose
      return dispose
    },

    async hasRwEntry(kind: string, profileName: string): Promise<boolean> {
      const registry = await loadRegistry(rwFile)
      return registry?.[kind]?.[profileName] !== undefined
    },

    async resolve(kind: string, profileName: string, agent?: AccessAgent): Promise<AccessProfile> {
      const provider = providers.get(kind)
      if (!provider) {
        const registered = [...providers.keys()].sort()
        throw new Error(`ops-access: unknown kind "${kind}" (no provider registered; registered kinds: ${registered.join(', ') || '(none)'})`)
      }
      // The broker is consulted only when one is registered AND an agent
      // context was supplied. No broker, or no agent (a system-internal call)
      // → ro, byte-for-byte the pre-gate behavior. This is the fail-closed
      // guarantee: rw is never issued without an agent to key the grant on.
      let tier: 'ro' | 'rw' = 'ro'
      if (broker && agent) {
        const decision = broker(kind, profileName, agent)
        if (typeof decision === 'object') {
          throw new Error(`ops-access: access denied for ${kind}/${profileName}: ${decision.deny}`)
        }
        if (decision === 'rw') tier = 'rw'
      }
      const file = tier === 'rw' ? rwFile : roFile
      const registry = await loadRegistry(file)
      if (registry === null) {
        throw new Error(`ops-access: registry file not found: ${file}`)
      }
      const section = registry[kind]
      const entry = section?.[profileName]
      if (entry === undefined) {
        const available = Object.keys(section ?? {}).sort()
        // On the rw tier the grant was already approved — say so, so the agent
        // reports "no rw credential registered" to the operator instead of
        // re-requesting a grant that can never be fulfilled.
        const hint = tier === 'rw' ? ' — a grant was approved but no rw credential is registered; ask the operator to add it to the rw registry' : ''
        throw new Error(`ops-access: no profile "${profileName}" for kind "${kind}" in registry file ${file} (available: ${available.join(', ') || '(none)'})${hint}`)
      }
      return buildProfile(provider, kind, profileName, entry, file)
    },

    async list(): Promise<AccessProfile[]> {
      const registry = await loadRegistry(roFile)
      if (registry === null) return []
      const profiles: AccessProfile[] = []
      for (const [kind, section] of Object.entries(registry)) {
        // Sections whose kind has no registered provider are skipped —
        // an unrecognized kind must not fail the whole listing.
        const provider = providers.get(kind)
        if (!provider) continue
        for (const [profileName, entry] of Object.entries(section)) {
          profiles.push(buildProfile(provider, kind, profileName, entry, roFile))
        }
      }
      return profiles
    },

    help(): string {
      const lines: string[] = [
        'Ops access registry — how to manage credentials',
        '',
        `File: ${roFile}`,
        'Re-read, re-parsed, and re-validated on EVERY call — edit it with the fs tools and the change takes effect immediately, no restart.',
        '',
        'Format:',
        '  version: 1',
        '  <kind>:',
        '    <profile-name>:',
        '      <kind-specific fields, see below>',
        '      description: what this profile is for   # optional, shown by list_access',
        '      environment: prod | staging | ...        # optional; the future audit gate reads this',
        '',
        'Registered kinds and their entry fields:',
      ]
      const kinds = [...providers.values()].sort((a, b) => a.kind.localeCompare(b.kind))
      if (kinds.length === 0) {
        lines.push('- (none registered)')
      }
      for (const p of kinds) {
        lines.push(`- ${p.kind}: ${p.fieldsDoc ?? '(no field docs provided by this provider)'}`)
      }
      lines.push('')
      lines.push('Secrets never go inline — fields carry file paths and connection params only, so logs and model context never contain secret material.')
      return lines.join('\n')
    },
  }

  ctx.provide('opsAccess', handle)

  // ── Mention candidate route (GET /ops-access/list) ────────────────────────
  // The browser's @ menu reads this. Preset-plane registration of a host
  // webServer route: reaching the preset-realm opsAccess FROM the host plane
  // would need stateful dsh internals (serviceForAgent), which dual-instance
  // under an external package's node_modules — so the route lives here, next
  // to the data. Envelope fields + ready-made mentions only; fields never
  // cross. Mounted once per process with the standing preset mount.
  ctx.inject(['webServer'], (wctx: Context) => {
    wctx.effect(() => (wctx as any).webServer.register({
      kind: 'exact',
      path: '/ops-access/list',
      handler: async (req: any, res: any) => {
        const url = new URL(req.url, 'http://localhost')
        const query = url.searchParams.get('query') ?? ''
        const needle = query.toLocaleLowerCase()
        const profiles = await handle.list()
        const candidates = profiles
          .filter((p) => needle === ''
            || `${p.kind}/${p.name}`.toLocaleLowerCase().includes(needle)
            || p.description?.toLocaleLowerCase().includes(needle) === true)
          .map((p) => ({
            kind: p.kind,
            name: p.name,
            ...p.description === undefined ? {} : { description: p.description },
            ...p.environment === undefined ? {} : { environment: p.environment },
            mention: formatAccessMention({ kind: p.kind, name: p.name }),
          }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(candidates))
      },
    }))
  })

  // ── Mention resolution (agent/pre-step) ───────────────────────────────────
  // Parse dsh-access mentions out of direct user messages: rewrite each to a
  // readable `@kind/name` and place one envelope-context message immediately
  // after the citing message — mirroring session-reference's pre-step shape.
  // Preset-plane listener, same `(ctx.on as any)` pattern as ops-prompts.
  ;(ctx.on as any)('agent/pre-step', async (payload: any, next: any) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const messages = decision.messages as any[]
    const out: any[] = []
    let changed = false
    for (const message of messages) {
      if (message.source?.kind !== 'user') { out.push(message); continue }
      const references: ParsedAccessReference[] = []
      const content = (message.content as any[]).map((block: any) => {
        if (block.type !== 'text') return block
        const parsed = parseAccessReferenceText(block.text)
        references.push(...parsed.references)
        return parsed.references.length === 0 ? block : { ...block, text: parsed.text }
      })
      if (references.length === 0) { out.push(message); continue }
      changed = true
      out.push(freezeMessage({ ...message, content }))
      out.push(createUserMessage({
        source: { kind: 'plugin', plugin: name, form: 'recall' },
        content: [{ type: 'text', text: await renderAccessReferences(handle, references) }],
      }))
    }
    return changed ? { kind: 'enter', messages: out } : decision
  }, { prepend: true })
}
