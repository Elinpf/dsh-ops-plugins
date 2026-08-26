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
 * Also registers the `register_access` tool: the agent's self-service path
 * for writing the ro tier of a profile (rw tiers stay human-managed via the
 * admin HTTP routes below).
 *
 * Registry format:
 *
 * ```yaml
 * version: 1
 * k8s:
 *   prod:
 *     description: 生产集群
 *     environment: prod
 *     ro:
 *       kubeconfig: ~/.dsh-ops/credentials/k8s/prod/ro/kubeconfig
 *     rw:
 *       kubeconfig: ~/.dsh-ops/credentials/k8s/prod/rw/kubeconfig
 * ```
 *
 * Every top-level section besides `version` is a kind; keys inside a section
 * are profile names. `description` and `environment` are envelope fields
 * on the entry; `ro` and `rw` are tier sub-objects holding the
 * provider-specific fields for that tier.
 *
 * @module @deepseek-ai/dsh-ops-access
 */

import { readFile, writeFile, mkdir, rm, rmdir } from 'node:fs/promises'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z as zod, type ZodType } from 'zod'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatAccessMention, parseAccessReferenceText } from './mention.js'
import type { ParsedAccessReference } from './mention.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access'

export const inject = ['tools']

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  /** Path to the YAML access registry; a leading `~` expands to $HOME. */
  registryFile: string
  /** Root directory for managed credential content files; a leading `~` expands to $HOME. */
  credentialsDir: string
}

export const Config: z<Config> = z.object({
  registryFile: z.string().default('~/.dsh-ops/access.yaml'),
  credentialsDir: z.string().default('~/.dsh-ops/credentials'),
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
  /**
   * How to DERIVE a read-only (ro) credential from the rw one for this kind
   * (the kubectl/ceph command sequence), including the naming convention for
   * the derived account. Surfaced by help(); the register_access tool points
   * the agent at it. Prose, not code — the agent executes the recipe with
   * judgment; exact commands drift with infrastructure versions.
   */
  derivationDoc?: string
  /**
   * Field names whose values are file PATHS pointing to credential material
   * (e.g. kubeconfig, ceph.conf, keyring, SSH private key). When the admin
   * UI receives CONTENT for these fields (instead of a path), it writes the
   * content to a managed file and stores the resulting path in the registry.
   * Fields not listed here are inline values stored as-is (e.g. ssh host, user, port).
   */
  fileFields?: string[]
  /**
   * Save-time validator for a file field's pasted CONTENT, run before the
   * content is written to disk (the admin UI route and the register_access
   * tool share this check). Return an error message to reject the write,
   * nothing to accept. Keep it structural — format and shape only (a ceph
   * keyring has an indented, base64-decodable key line; a kubeconfig parses
   * as YAML with clusters/contexts/users), never connectivity or value
   * judgments. Catching paste corruption here beats a cryptic CLI parse
   * error at use time.
   */
  validateContent?: (field: string, content: string) => string | null | undefined
}

/** A resolved access profile: envelope fields plus the provider-processed type-specific fields. */
export interface AccessProfile {
  kind: string
  /** The entry's registry key — its stable id (paths, mentions, grants). */
  name: string
  /**
   * The tier this resolve actually served ('rw' only via a broker grant).
   * Consumers use it to label credential references, e.g. the shell-tool
   * factory's <id@tier:field> display tokens.
   */
  tier: 'ro' | 'rw'
  /** Display label from the envelope's `name` field (editable, not an identity). */
  displayName?: string
  description?: string
  environment?: string
  /** Type-specific fields after provider schema validation and process. */
  fields: Record<string, unknown>
}

/**
 * Envelope fields common to every entry (not provider-specific). The entry's
 * registry key is its stable, human-readable **id** (used in file paths,
 * mentions, tool calls, grants, and relation references); `name` is a
 * freely editable display label — changing it touches nothing on disk.
 */
export interface EntryEnvelope {
  /** Display name — modifiable, never referenced by id-based machinery. */
  name?: string
  description?: string
  environment?: string
}

/** Validation status of one entry in one tier — `error` carries the zod reason, never field values. */
export interface AdminTierStatus {
  ok: boolean
  error?: string
}

/** One entry in the merged admin view: envelope + per-tier validation status, never fields. */
export interface AdminEntry {
  kind: string
  name: string
  envelope: EntryEnvelope
  tiers: { ro: AdminTierStatus, rw: AdminTierStatus }
}

/** One registered credential kind: its JSON Schema (from `zod.toJSONSchema`) and optional field docs. */
export interface KindDescriptor {
  kind: string
  jsonSchema: Record<string, unknown>
  fieldsDoc?: string
  /** Field names that are file paths (content is managed by the admin UI). */
  fileFields?: string[]
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
 * - `'ro'` — serve the profile's `ro` tier from the registry
 * - `'rw'` — serve the profile's `rw` tier from the registry
 * - `{ deny }` — refuse; core throws the broker's message verbatim (the
 *   broker owns the guidance, e.g. pointing at `request_access`).
 */
export type AccessBrokerDecision = 'ro' | 'rw' | { deny: string }

/**
 * The pure decision function a gate registers. Receives only kind, profile
 * name, and the caller agent — never credential fields. Once a broker is
 * registered, resolve consults it on EVERY call; `agent` is `undefined` for
 * system-internal calls, and the no-agent ruling belongs to the broker (core
 * does not answer policy on its behalf). Without a registered broker, resolve
 * is unchanged from the broker-less behavior (ro).
 */
export type AccessBroker = (kind: string, name: string, agent: AccessAgent | undefined) => AccessBrokerDecision

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
   * Whether resolving this profile from the given tier would succeed right
   * now: the entry exists AND passes the provider schema. Never returns
   * fields, never consults the broker — the gate uses it to reject
   * undeliverable requests BEFORE bothering the human approver.
   *
   * Returns `{ ok: true }` when the entry exists and validates. Returns
   * `{ ok: false, error }` when the entry exists but fails provider-schema
   * validation — `error` is built from the zod issue paths and messages
   * (never raw field values). Returns `{ ok: false }` (no `error`) for
   * structural failures: unknown kind, missing file, unparseable file, or
   * missing entry.
   */
  canResolve(kind: string, name: string, tier: 'ro' | 'rw'): Promise<{ ok: boolean, error?: string }>
  /**
   * Resolve one profile by kind and name. Throws on unknown kind, unknown
   * name, or invalid entry. When a broker is registered it is consulted on
   * every call — including calls without an `agent` (the broker owns the
   * no-agent ruling) — and decides whether the rw profile is served. Without
   * a broker the ro profile (from `registryFile`) is served, byte-for-byte
   * as before.
   */
  resolve(kind: string, name: string, agent?: AccessAgent): Promise<AccessProfile>
  /** List all profiles across all registered kinds. Sections without a registered provider are skipped. */
  list(): Promise<AccessProfile[]>
  /**
   * Write (upsert) one tier of one entry in the registry. Reads the file,
   * sets entry[tier] to the given fields, validates the tier via the provider
   * schema (buildProfile), and writes back. A validation failure throws and
   * leaves the file untouched. Creates the file if it does not exist.
   * The envelope is applied field-by-field: omitted fields are preserved,
   * empty-string fields are deleted, so updating one tier never clobbers
   * the existing envelope but the operator can still clear a field.
   */
  writeEntry(kind: string, name: string, tier: 'ro' | 'rw', fields: Record<string, unknown>, envelope?: EntryEnvelope): Promise<void>
  /**
   * Delete one tier of one entry from the registry. Returns true when the
   * tier was deleted, false when the file, entry, or tier did not exist.
   * When the entry's last tier is removed the whole entry is dropped, and
   * the tier's managed credential files are removed with it.
   */
  deleteEntry(kind: string, name: string, tier: 'ro' | 'rw'): Promise<boolean>
  /**
   * List all entries across both tiers, merged by kind/name. Each entry
   * carries its envelope (from whichever tier has it) and per-tier validation
   * status via canResolve — never fields.
   */
  listAll(): Promise<AdminEntry[]>
  /**
   * Read back one entry's NON-file fields and envelope for editing. Returns
   * null when the entry or file does not exist. File fields (credential
   * content) are write-only after save: never returned, not even as paths —
   * only their set status in `fileFields`. The caller (the admin UI) is a
   * human operator, not the agent — non-file values are connection params,
   * never secret material.
   */
  getEntry(kind: string, name: string, tier: 'ro' | 'rw'): Promise<{ fields: Record<string, unknown>, fileFields: Record<string, boolean>, displayName?: string, description?: string, environment?: string } | null>
  /**
   * List all registered credential kinds with their JSON Schema (serialized
   * via `zod.toJSONSchema(provider.schema)`) and optional field docs.
   * Unregistered kinds do not appear.
   */
  listKinds(): KindDescriptor[]
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

/**
 * Validate one tier sub-object against the provider schema and build the
 * profile. `raw` carries only the provider fields; the envelope
 * (description/environment) lives on the parent entry and is passed separately.
 */
function buildProfile(provider: AccessProvider, kind: string, profileName: string, tier: 'ro' | 'rw', raw: unknown, file: string, parentEntry?: Record<string, unknown>): AccessProfile {
  if (!isPlainObject(raw)) {
    throw new Error(`ops-access: entry ${kind}.${profileName} in registry file ${file} must be a mapping`)
  }
  const result = provider.schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`ops-access: invalid entry ${kind}.${profileName} in registry file ${file}: ${issues}`)
  }
  const fields = provider.process
    ? provider.process(result.data, profileName)
    : result.data as Record<string, unknown>
  const profile: AccessProfile = { kind, name: profileName, tier, fields }
  const env = parentEntry ?? {}
  if (typeof env.name === 'string') profile.displayName = env.name
  if (typeof env.description === 'string') profile.description = env.description
  if (typeof env.environment === 'string') profile.environment = env.environment
  return profile
}

/** Serialize a registry back to its YAML file with the version header. */
async function saveRegistry(file: string, registry: Registry): Promise<void> {
  const doc: Record<string, unknown> = { version: 1 }
  for (const [kind, section] of Object.entries(registry)) {
    doc[kind] = section
  }
  await writeFile(file, stringifyYaml(doc), 'utf8')
}

/** Read the full HTTP request body as a string. */
function readRequestBody(req: { on: (event: string, cb: (chunk?: Buffer | string) => void) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk?: Buffer | string) => { if (chunk !== undefined) data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Send a JSON error response — message from buildProfile carries zod paths, never field values. */
function sendJsonError(res: { writeHead: (status: number, headers?: Record<string, string>) => void, end: (text: string) => void }, status: number, err: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: String((err as Error | null)?.message ?? err) }))
}

/** Build an EntryEnvelope from raw entry data, taking each envelope field from the first source that has it. */
function buildEnvelope(sources: Array<Record<string, unknown> | undefined>): EntryEnvelope {
  const envelope: EntryEnvelope = {}
  for (const source of sources) {
    if (!isPlainObject(source)) continue
    if (envelope.name === undefined && typeof source.name === 'string') envelope.name = source.name
    if (envelope.description === undefined && typeof source.description === 'string') envelope.description = source.description
    if (envelope.environment === undefined && typeof source.environment === 'string') envelope.environment = source.environment
  }
  return envelope
}

/** Split "kind/name" on the FIRST slash — profile names may contain '@' etc. */
function parseProfile(raw: unknown): { kind: string, profileName: string } | undefined {
  if (typeof raw !== 'string') return undefined
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { kind: raw.slice(0, slash), profileName: raw.slice(slash + 1) }
}

/**
 * Write credential CONTENT to managed files under
 * `<credentialsDir>/<kind>/<name>/<tier>/<field>` and record the resulting
 * paths in entryFields. Shared by the admin POST route (the human writer)
 * and the register_access tool (the agent writer). Only fields the provider
 * declared in fileFields may be content-written, and field names are
 * charset-guarded against path escape. Files are written 0600 — they carry
 * secret material.
 */
/**
 * The profile name is the entry's stable id: it lands in credential file
 * paths (credentials/<kind>/<name>/<tier>/<field>) and in mention syntax
 * (@[kind/name]), so reject anything path- or syntax-hostile. Writer paths
 * call this BEFORE any file IO — a bad name must not leave orphan files.
 */
function assertValidProfileName(profileName: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(profileName)) {
    throw new Error(`ops-access: invalid profile name "${profileName}" — must start with a letter or digit and contain only letters, digits, '.', '_', '-', '@'`)
  }
}

async function writeContentFiles(credentialsDir: string, kind: string, profileName: string, tier: string, fileFields: readonly string[], contentFiles: Record<string, unknown>, entryFields: Record<string, unknown>, validateContent?: AccessProvider['validateContent']): Promise<string[]> {
  const allowed = new Set(fileFields)
  const written: string[] = []
  for (const [fieldName, content] of Object.entries(contentFiles)) {
    // Empty content means "untouched" (the edit form leaves saved file
    // fields blank) — never clobber a stored credential with it.
    if (typeof content !== 'string' || content.trim() === '') continue
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fieldName)) {
      throw new Error(`ops-access: invalid file field name "${fieldName}"`)
    }
    if (!allowed.has(fieldName)) {
      throw new Error(`ops-access: "${fieldName}" is not a declared file field for kind "${kind}" (declared: ${fileFields.join(', ') || '(none)'})`)
    }
    // Save-time content validation (provider hook): reject corrupt pastes
    // BEFORE anything lands on disk.
    const problem = validateContent?.(fieldName, content)
    if (problem) {
      throw new Error(`ops-access: invalid content for ${kind}/${profileName} ${tier} ${fieldName}: ${problem}`)
    }
    const dir = credentialsDir + '/' + kind + '/' + profileName + '/' + tier
    await mkdir(dir, { recursive: true })
    const filePath = dir + '/' + fieldName
    await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 })
    written.push(filePath)
    entryFields[fieldName] = filePath
  }
  return written
}

/**
 * Roll back files writeContentFiles just wrote when the accompanying
 * writeEntry fails — a rejected registration must not leave orphan
 * credential files on disk. Also removes the directories this write created
 * (rmdir refuses non-empty ones, so pre-existing content is never touched).
 */
async function rollbackContentFiles(credentialsDir: string, kind: string, profileName: string, tier: string, written: readonly string[]): Promise<void> {
  for (const filePath of written) await rm(filePath, { force: true })
  for (const dir of [
    credentialsDir + '/' + kind + '/' + profileName + '/' + tier,
    credentialsDir + '/' + kind + '/' + profileName,
    credentialsDir + '/' + kind,
  ]) {
    try { await rmdir(dir) } catch { /* non-empty or already gone — leave it */ }
  }
}

// ── Mention injection (agent/pre-step) ──────────────────────────────────────

/**
 * Render the envelope context for referenced profiles. Envelope fields only —
 * fields (paths, connection params) never cross into model context, keeping
 * the structural secrecy discipline. Unknown profiles degrade to a note, not
 * an error: a stale mention must not block the step.
 *
 * Reads through `listAll()`, not `resolve()`: mention rendering is metadata
 * display, not credential issuance — it must never consult the broker, or an
 * approval-required profile (ssh) would render as "not found" simply because
 * the session holds no grant. listAll (not list) so rw-only entries render
 * too — they exist in the registry, the agent just cannot read them yet.
 */
async function renderAccessReferences(
  handle: OpsAccess,
  references: readonly ParsedAccessReference[],
): Promise<string> {
  const entries = await handle.listAll().catch(() => [] as AdminEntry[])
  const seen = new Set<string>()
  const lines: string[] = []
  for (const ref of references) {
    const key = `${ref.kind}/${ref.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const entry = entries.find((e) => e.kind === ref.kind && e.name === ref.name)
    if (!entry) {
      lines.push(`- ${key} — (not found in the access registry; run list_access to see available profiles)`)
      continue
    }
    const env = entry.envelope.environment ? ` [${entry.envelope.environment}]` : ''
    const label = entry.envelope.name ? ` (${entry.envelope.name})` : ''
    const desc = entry.envelope.description ? ` — ${entry.envelope.description}` : ''
    const tierNote = !entry.tiers.ro.ok && entry.tiers.rw.ok
      ? ' (no ro tier registered yet — derivable from rw via the register_access tool)'
      : ''
    lines.push(`- ${key}${label}${env}${desc}${tierNote}`)
  }
  return `<referenced-access>\nThe user explicitly referenced these access profiles (use them with the matching tools):\n${lines.join('\n')}\n</referenced-access>`
}
// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const registryFile = expandHome(config.registryFile)
  const credentialsDir = expandHome(config.credentialsDir)
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

    async canResolve(kind: string, profileName: string, tier: 'ro' | 'rw'): Promise<{ ok: boolean, error?: string }> {
      const provider = providers.get(kind)
      if (!provider) return { ok: false }
      // Load + locate the entry in its own try/catch: a missing or unparseable
      // file is a structural "not resolvable" with no validation reason — the
      // admin does not need a zod message to fix a file that isn't there.
      let raw: unknown
      let parentEntry: Record<string, unknown> | undefined
      try {
        const registry = await loadRegistry(registryFile)
        if (registry === null) return { ok: false }
        const entry = registry[kind]?.[profileName]
        if (!isPlainObject(entry)) return { ok: false }
        parentEntry = entry as Record<string, unknown>
        raw = parentEntry[tier]
      } catch {
        return { ok: false }
      }
      if (!isPlainObject(raw)) return { ok: false }
      // Run the same buildProfile validation resolve would run — a precheck
      // shallower than the real issuance approves grants that cannot be
      // fulfilled. The profile itself is discarded: existence, not fields.
      // A validation failure surfaces the reason (zod issue paths + messages,
      // never raw field values) so the admin UI can show it.
      try {
        buildProfile(provider, kind, profileName, tier, raw, registryFile, parentEntry)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: String((err as Error | null)?.message ?? err) }
      }
    },

    async resolve(kind: string, profileName: string, agent?: AccessAgent): Promise<AccessProfile> {
      const provider = providers.get(kind)
      if (!provider) {
        const registered = [...providers.keys()].sort()
        throw new Error(`ops-access: unknown kind "${kind}" (no provider registered; registered kinds: ${registered.join(', ') || '(none)'})`)
      }
      // Once a broker is registered it is consulted on EVERY resolve —
      // including calls without an agent. The no-agent ruling (fail closed to
      // ro, or deny outright) is policy, and policy lives in the broker, not
      // here. Without a broker, rw is never issued at all.
      let tier: 'ro' | 'rw' = 'ro'
      if (broker) {
        const decision = broker(kind, profileName, agent)
        if (typeof decision === 'object') {
          throw new Error(`ops-access: access denied for ${kind}/${profileName}: ${decision.deny}`)
        }
        if (decision === 'rw') tier = 'rw'
      }
      const registry = await loadRegistry(registryFile)
      if (registry === null) {
        throw new Error(`ops-access: registry file not found: ${registryFile}`)
      }
      const section = registry[kind]
      const entry = section?.[profileName]
      if (!isPlainObject(entry)) {
        const available = Object.keys(section ?? {}).sort()
        const hint = tier === 'rw' ? ' — a grant was approved but no rw credential is registered; ask the operator to add it via the admin UI' : ''
        throw new Error(`ops-access: no profile "${profileName}" for kind "${kind}" in registry file ${registryFile} (available: ${available.join(', ') || '(none)'})${hint}`)
      }
      const tierData = (entry as Record<string, unknown>)[tier]
      if (!isPlainObject(tierData)) {
        // On the rw tier the grant was already approved — say so, so the agent
        // reports "no rw credential registered" to the operator instead of
        // re-requesting a grant that can never be fulfilled. On the ro tier
        // with rw present, point at the self-service derivation path.
        const hint = tier === 'rw'
          ? ' — a grant was approved but no rw credential is registered; ask the operator to add it via the admin UI'
          : isPlainObject((entry as Record<string, unknown>).rw)
            ? ' — the rw tier is registered; derive a read-only credential from it (list_access help: true has the recipe) and register it via the register_access tool'
            : ''
        throw new Error(`ops-access: no ${tier} tier for profile "${profileName}" (kind "${kind}") in registry file ${registryFile}${hint}`)
      }
      return buildProfile(provider, kind, profileName, tier, tierData, registryFile, entry as Record<string, unknown>)
    },

    async list(): Promise<AccessProfile[]> {
      const registry = await loadRegistry(registryFile)
      if (registry === null) return []
      const profiles: AccessProfile[] = []
      for (const [kind, section] of Object.entries(registry)) {
        // Sections whose kind has no registered provider are skipped —
        // an unrecognized kind must not fail the whole listing.
        const provider = providers.get(kind)
        if (!provider) continue
        for (const [profileName, entry] of Object.entries(section)) {
          // list() surfaces the agent-readable ro tier only.
          if (!isPlainObject(entry)) continue
          const roData = (entry as Record<string, unknown>).ro
          if (!isPlainObject(roData)) continue
          profiles.push(buildProfile(provider, kind, profileName, 'ro', roData, registryFile, entry as Record<string, unknown>))
        }
      }
      return profiles
    },

    help(): string {
      const lines: string[] = [
        'Ops access registry — how to manage credentials',
        '',
        `File: ${registryFile}`,
        'Re-read, re-parsed, and re-validated on EVERY call — edit it with the fs tools and the change takes effect immediately, no restart.',
        '',
        'Format:',
        '  version: 1',
        '  <kind>:',
        '    <profile-id>:                            # stable id: letters/digits plus . _ - @; used in paths, mentions, grants',
        '      name: display label, freely editable   # optional, UI-facing only',
        '      description: what this profile is for   # optional, shown by list_access',
        '      environment: prod | staging | ...        # optional; the future audit gate reads this',
        '      ro:                                      # ro tier fields (agent-readable default)',
        '        <kind-specific fields, see below>',
        '      rw:                                      # rw tier fields (grant-gated)',
        '',
        'Registered kinds and their entry fields:',
      ]
      const kinds = [...providers.values()].sort((a, b) => a.kind.localeCompare(b.kind))
      if (kinds.length === 0) {
        lines.push('- (none registered)')
      }
      for (const p of kinds) {
        lines.push(`- ${p.kind}: ${p.fieldsDoc ?? '(no field docs provided by this provider)'}`)
        if (p.derivationDoc) lines.push(`  derive ro: ${p.derivationDoc}`)
      }
      lines.push('')
      lines.push('Agents register ro tiers with the register_access tool — rw tiers stay human-managed via the admin UI.')
      lines.push('Secrets never go inline — fields carry file paths and connection params only, so logs and model context never contain secret material.')
      return lines.join('\n')
    },

    async writeEntry(kind: string, profileName: string, tier: 'ro' | 'rw', fields: Record<string, unknown>, envelope?: EntryEnvelope): Promise<void> {
      const provider = providers.get(kind)
      if (!provider) {
        const registered = [...providers.keys()].sort()
        throw new Error(`ops-access: unknown kind "${kind}" (no provider registered; registered kinds: ${registered.join(', ') || '(none)'})`)
      }
      assertValidProfileName(profileName)
      // The tier sub-object carries only provider fields; the envelope
      // (name/description/environment) lives on the parent entry.
      const tierData: Record<string, unknown> = { ...fields }
      // Read → merge → validate → write back. A missing file starts from an
      // empty registry; an unparseable file throws (we will not overwrite a
      // file we cannot read).
      let registry: Registry = {}
      const loaded = await loadRegistry(registryFile)
      if (loaded !== null) registry = loaded
      if (!registry[kind]) registry[kind] = {}
      if (!isPlainObject(registry[kind][profileName])) registry[kind][profileName] = {}
      const entry = registry[kind][profileName] as Record<string, unknown>
      entry[tier] = tierData
      // Envelope discipline: omitted = preserve, empty string = delete, else set.
      // The admin UI always sends all three so the operator can clear them.
      if (envelope?.name !== undefined) {
        if (envelope.name === '') delete entry.name
        else entry.name = envelope.name
      }
      if (envelope?.description !== undefined) {
        if (envelope.description === '') delete entry.description
        else entry.description = envelope.description
      }
      if (envelope?.environment !== undefined) {
        if (envelope.environment === '') delete entry.environment
        else entry.environment = envelope.environment
      }
      // Validate via buildProfile BEFORE writing — a schema failure must not
      // touch the file. buildProfile throws with zod issue paths + messages,
      // never raw field values. (The in-memory merged entry is what we
      // validate, matching the spec's read→merge→validate→write sequence.)
      buildProfile(provider, kind, profileName, tier, tierData, registryFile, entry)
      await saveRegistry(registryFile, registry)
    },

    async deleteEntry(kind: string, profileName: string, tier: 'ro' | 'rw'): Promise<boolean> {
      const registry = await loadRegistry(registryFile)
      if (registry === null) return false
      const section = registry[kind]
      if (!section || !(profileName in section)) return false
      const entry = section[profileName]
      if (!isPlainObject(entry)) return false
      // Remove the tier sub-object and its managed credential files.
      delete (entry as Record<string, unknown>)[tier]
      const provider = providers.get(kind)
      if (provider?.fileFields && provider.fileFields.length > 0) {
        await rm(credentialsDir + '/' + kind + '/' + profileName + '/' + tier, { recursive: true, force: true })
      }
      // If neither tier remains, remove the whole entry, its credential
      // directory, and drop empty sections.
      const remaining = ['ro', 'rw'].filter((t) => (entry as Record<string, unknown>)[t] !== undefined)
      if (remaining.length === 0) {
        delete section[profileName]
        if (Object.keys(section).length === 0) delete registry[kind]
        if (provider?.fileFields && provider.fileFields.length > 0) {
          await rm(credentialsDir + '/' + kind + '/' + profileName, { recursive: true, force: true })
        }
      }
      await saveRegistry(registryFile, registry)
      return true
    },

    async listAll(): Promise<AdminEntry[]> {
      // Load the single registry for enumeration. A parse error degrades to
      // an empty list — canResolve reports the failure per tier.
      let registry: Registry = {}
      try { const r = await loadRegistry(registryFile); if (r) registry = r } catch { /* canResolve reports the failure */ }
      const result: AdminEntry[] = []
      for (const kind of Object.keys(registry).sort()) {
        if (!providers.has(kind)) continue
        const section = registry[kind]
        if (!section) continue
        for (const name of Object.keys(section).sort()) {
          const entry = section[name]
          if (!isPlainObject(entry)) continue
          const envelope = buildEnvelope([entry as Record<string, unknown>])
          const roStatus = await handle.canResolve(kind, name, 'ro')
          const rwStatus = await handle.canResolve(kind, name, 'rw')
          result.push({ kind, name, envelope, tiers: { ro: roStatus, rw: rwStatus } })
        }
      }
      return result
    },

    listKinds(): KindDescriptor[] {
      return [...providers.values()]
        .sort((a, b) => a.kind.localeCompare(b.kind))
        .map((p) => {
          const descriptor: KindDescriptor = { kind: p.kind, jsonSchema: zod.toJSONSchema(p.schema), ...(p.fileFields ? { fileFields: p.fileFields } : {}) }
          if (p.fieldsDoc !== undefined) descriptor.fieldsDoc = p.fieldsDoc
          return descriptor
        })
    },

    async getEntry(kind: string, profileName: string, tier: 'ro' | 'rw'): Promise<{ fields: Record<string, unknown>, fileFields: Record<string, boolean>, displayName?: string, description?: string, environment?: string } | null> {
      const provider = providers.get(kind)
      if (!provider) return null
      let registry: Registry | null
      try {
        registry = await loadRegistry(registryFile)
      } catch {
        return null
      }
      if (registry === null) return null
      const entry = registry[kind]?.[profileName]
      if (!isPlainObject(entry)) return null
      const parent = entry as Record<string, unknown>
      const raw = parent[tier]
      if (!isPlainObject(raw)) return null
      // Return the tier's NON-file fields plus the parent's envelope. File
      // fields (credential content) are write-only after save: content is
      // never read back — not even the managed path — only the set status
      // rides along so the UI can render "已保存，粘贴新内容以覆盖". This
      // keeps stored credentials unreachable for anyone (or anything) that
      // can merely reach the admin routes.
      const { name: displayName, description, environment } = parent
      const fields: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
      const fileFields: Record<string, boolean> = {}
      for (const ff of provider.fileFields ?? []) {
        const stored = fields[ff]
        fileFields[ff] = typeof stored === 'string' && stored.length > 0
        delete fields[ff]
      }
      const result: { fields: Record<string, unknown>, fileFields: Record<string, boolean>, displayName?: string, description?: string, environment?: string } = { fields, fileFields }
      if (typeof displayName === 'string') result.displayName = displayName
      if (typeof description === 'string') result.description = description
      if (typeof environment === 'string') result.environment = environment
      return result
    },
  }

  ctx.provide('opsAccess', handle)

  // ── register_access tool (agent-facing ro-tier writer) ────────────────────
  // The agent's self-service registration path: it derives a read-only
  // credential from the rw one (per-kind recipe in the provider's
  // derivationDoc, surfaced by help()) and writes the ro tier here.
  // Deliberately ungated — the ro tier is the agent's default operating
  // level and the operator can overwrite it from the admin UI at any time;
  // the rw tier stays human-only (no tool writes it). Tool calls sit in the
  // session event log, so every registration is reconstructable.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'register_access',
    description:
      'Register or overwrite the read-only (ro) credential tier of an access profile — typically a credential you derived from the rw tier (a read-only ServiceAccount token, a read-only cephx keyring, a dedicated SSH key). The rw tier is human-managed via the admin UI; this tool writes ro only. File fields (kubeconfig, conf, keyring, key) take full file CONTENT, stored to a managed path automatically; other fields are inline values. Run list_access with help: true for per-kind field docs and derivation recipes.',
    parameters: {
      profile: { type: 'string', required: true, description: '"kind/id", e.g. "k8s/prod". The entry is created when it does not exist yet.' },
      fields: { type: 'object', additionalProperties: true, required: true, description: 'The ro tier field values for this kind. File fields take full content, not paths.' },
      description: { type: 'string', description: 'Optional envelope description (empty string clears it).' },
      environment: { type: 'string', description: 'Optional envelope environment label (empty string clears it).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      // Pure function of (args, value): same inputs, same text, no state touched.
      render: (_args: unknown, value: { ok: boolean, message: string }) => [{ type: 'text' as const, text: value.message }],
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean, message: string }> {
      const parsed = parseProfile(args.profile)
      if (!parsed) {
        return { ok: false, message: 'profile must be "kind/id", e.g. "k8s/prod"' }
      }
      const { kind, profileName } = parsed
      const kinds = handle.listKinds()
      const descriptor = kinds.find((k) => k.kind === kind)
      if (!descriptor) {
        const registered = kinds.map((k) => k.kind).sort()
        return { ok: false, message: `unknown kind "${kind}" (registered kinds: ${registered.join(', ') || '(none)'})` }
      }
      if (!isPlainObject(args.fields)) {
        return { ok: false, message: 'fields must be an object of ro tier field values' }
      }
      // File fields take CONTENT from the agent; everything else is inline.
      const entryFields: Record<string, unknown> = {}
      const contentFiles: Record<string, string> = {}
      const fileFieldSet = new Set(descriptor.fileFields ?? [])
      for (const [fieldName, value] of Object.entries(args.fields)) {
        if (fileFieldSet.has(fieldName) && typeof value === 'string') contentFiles[fieldName] = value
        else entryFields[fieldName] = value
      }
      const envelope: EntryEnvelope = {}
      if (typeof args.description === 'string') envelope.description = args.description
      if (typeof args.environment === 'string') envelope.environment = args.environment
      // Reject a bad id BEFORE any file IO, and roll back written files when
      // writeEntry fails — a rejected registration must not leave orphan
      // credential files on disk.
      try {
        assertValidProfileName(profileName)
      } catch (err) {
        return { ok: false, message: String((err as Error | null)?.message ?? err) }
      }
      let written: string[] = []
      try {
        if (Object.keys(contentFiles).length > 0) {
          written = await writeContentFiles(credentialsDir, kind, profileName, 'ro', descriptor.fileFields ?? [], contentFiles, entryFields, providers.get(kind)?.validateContent)
        }
        // writeEntry validates against the provider schema BEFORE touching
        // the registry; its errors carry zod issue paths + messages, never
        // raw field values.
        await handle.writeEntry(kind, profileName, 'ro', entryFields, Object.keys(envelope).length > 0 ? envelope : undefined)
      } catch (err) {
        await rollbackContentFiles(credentialsDir, kind, profileName, 'ro', written)
        return { ok: false, message: `registration failed: ${String((err as Error | null)?.message ?? err)}` }
      }
      return { ok: true, message: `Registered the ro tier of ${kind}/${profileName}. Verify it with a read command before relying on it.` }
    },
  })))

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
        // listAll, not list: the picker must also show entries that carry
        // only an rw tier (operator-registered, ro not yet derived) — hiding
        // them would make the rw→ro derivation flow unreachable from the UI.
        // Tier readiness flags ride along so the picker can badge them;
        // fields never cross (listAll is envelope + status only).
        const entries = await handle.listAll()
        const candidates = entries
          .filter((e) => needle === ''
            || `${e.kind}/${e.name}`.toLocaleLowerCase().includes(needle)
            || e.envelope.name?.toLocaleLowerCase().includes(needle) === true
            || e.envelope.description?.toLocaleLowerCase().includes(needle) === true)
          .map((e) => ({
            kind: e.kind,
            name: e.name,
            ...e.envelope.name === undefined ? {} : { displayName: e.envelope.name },
            ...e.envelope.description === undefined ? {} : { description: e.envelope.description },
            ...e.envelope.environment === undefined ? {} : { environment: e.envelope.environment },
            ro: e.tiers.ro.ok,
            rw: e.tiers.rw.ok,
            mention: formatAccessMention({ kind: e.kind, name: e.name }),
          }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(candidates))
      },
    }))

    // ── Admin routes (GET /admin/list, GET /admin/kinds, POST+DELETE /admin/entry) ─
    // The webServer matches by path only (no HTTP method), so the entry route
    // dispatches on req.method. All responses and errors exclude field values
    // — buildProfile errors carry zod issue paths + messages, never raw values.
    wctx.effect(() => (wctx as any).webServer.register({
      kind: 'exact',
      path: '/ops-access/admin/list',
      handler: async (_req: any, res: any) => {
        try {
          const entries = await handle.listAll()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(entries))
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    wctx.effect(() => (wctx as any).webServer.register({
      kind: 'exact',
      path: '/ops-access/admin/kinds',
      handler: async (_req: any, res: any) => {
        try {
          const kinds = handle.listKinds()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(kinds))
        } catch (err) {
          sendJsonError(res, 500, err)
        }
      },
    }))

    wctx.effect(() => (wctx as any).webServer.register({
      kind: 'exact',
      path: '/ops-access/admin/entry',
      handler: async (req: any, res: any) => {
        try {
          if (req.method === 'POST') {
            const body = await readRequestBody(req)
            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(body) as Record<string, unknown>
            } catch {
              sendJsonError(res, 400, new Error('request body must be valid JSON'))
              return
            }
            const { kind, name, tier, fields, displayName, description, environment, contentFiles } = parsed
            if (typeof kind !== 'string' || typeof name !== 'string' || (tier !== 'ro' && tier !== 'rw')) {
              sendJsonError(res, 400, new Error('kind (string), name (string), and tier ("ro"|"rw") are required'))
              return
            }
            const entryFields = isPlainObject(fields) ? fields : {}
            // Content files: the UI sends credential file CONTENT (e.g. the full
            // kubeconfig YAML) instead of a path. Write each to a managed file
            // and store the path in entryFields. The id is validated BEFORE any
            // file IO, and written files are rolled back when writeEntry fails —
            // a rejected write must not leave orphan credential files on disk.
            const provider = providers.get(kind)
            assertValidProfileName(name)
            let writtenFiles: string[] = []
            if (isPlainObject(contentFiles)) {
              writtenFiles = await writeContentFiles(credentialsDir, kind, name, tier, provider?.fileFields ?? [], contentFiles, entryFields, provider?.validateContent)
            }
            // Write-only-after-save preserve: file fields never come back
            // from the UI (getEntry withholds them), so an edit request
            // cannot carry them. Carry over the stored path for any declared
            // file field the request omits — otherwise the tier-replace
            // write would silently drop the credential.
            if (provider?.fileFields?.length) {
              const existing = await loadRegistry(registryFile)
              const existingEntry = existing?.[kind]?.[name]
              const existingTier = isPlainObject(existingEntry) ? (existingEntry as Record<string, unknown>)[tier] : undefined
              if (isPlainObject(existingTier)) {
                for (const ff of provider.fileFields) {
                  if (entryFields[ff] === undefined && typeof (existingTier as Record<string, unknown>)[ff] === 'string') {
                    entryFields[ff] = (existingTier as Record<string, unknown>)[ff]
                  }
                }
              }
            }
            const envelope = buildEnvelope([{ name: displayName, description, environment }])
            try {
              await handle.writeEntry(kind, name, tier, entryFields, Object.keys(envelope).length > 0 ? envelope : undefined)
            } catch (err) {
              await rollbackContentFiles(credentialsDir, kind, name, tier, writtenFiles)
              throw err
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          } else if (req.method === 'GET') {
            const url = new URL(req.url, 'http://localhost')
            const kind = url.searchParams.get('kind')
            const name = url.searchParams.get('name')
            const tier = url.searchParams.get('tier')
            if (!kind || !name || (tier !== 'ro' && tier !== 'rw')) {
              sendJsonError(res, 400, new Error('kind, name, and tier ("ro"|"rw") query parameters are required'))
              return
            }
            const entry = await handle.getEntry(kind, name, tier)
            if (entry === null) {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify(null))
            } else {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify(entry))
            }
          } else if (req.method === 'DELETE') {
            const url = new URL(req.url, 'http://localhost')
            const kind = url.searchParams.get('kind')
            const name = url.searchParams.get('name')
            const tier = url.searchParams.get('tier')
            if (!kind || !name || (tier !== 'ro' && tier !== 'rw')) {
              sendJsonError(res, 400, new Error('kind, name, and tier ("ro"|"rw") query parameters are required'))
              return
            }
            const deleted = await handle.deleteEntry(kind, name, tier)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(deleted ? { ok: true } : { ok: false, error: 'entry not found' }))
          } else {
            sendJsonError(res, 405, new Error('method not allowed'))
          }
        } catch (err) {
          // buildProfile errors carry zod issue paths + messages, never field values.
          sendJsonError(res, 400, err)
        }
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
