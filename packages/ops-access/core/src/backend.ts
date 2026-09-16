/**
 * Credential-source backends for the ops-access seam.
 *
 * The `OpsAccess` handle (index.ts) owns policy — broker decisions, profile
 * validation via provider schemas, envelope merge semantics, probes — and
 * delegates raw entry persistence to an `AccessBackend`. Two backends exist:
 *
 * - `YamlBackend` — the original local YAML registry file (default).
 * - `HubBackend` (hub-backend.ts) — a remote ops-access-hub service; secret
 *   content is fetched per resolve and materialized to managed local files.
 *
 * Both speak the same provider-shaped language: file fields are LOCAL PATHS
 * in `fields` (the hub backend converts content ↔ path at its boundary), the
 * envelope (`name`/`description`/`environment`) is per-entry, and a `probe`
 * may ride beside each tier.
 *
 * @module @elinpf/dsh-ops-access/backend
 */

import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { EntryEnvelope, ProbeState } from './types.js'

// ── Shared helpers ───────────────────────────────────────────────────────────

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Expand a leading `~` (or `~/`) to the user's home directory. */
export function expandHome(p: string): string {
  const home = process.env.HOME ?? os.homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p
}

/** Build an EntryEnvelope from raw entry data, taking each envelope field from the first source that has it. */
export function buildEnvelope(sources: Array<Record<string, unknown> | undefined>): EntryEnvelope {
  const envelope: EntryEnvelope = {}
  for (const source of sources) {
    if (!isPlainObject(source)) continue
    if (envelope.name === undefined && typeof source.name === 'string') envelope.name = source.name
    if (envelope.description === undefined && typeof source.description === 'string') envelope.description = source.description
    if (envelope.environment === undefined && typeof source.environment === 'string') envelope.environment = source.environment
  }
  return envelope
}

/** Read a persisted probe result off a raw tier object (durable boundary — sanitize). */
export function probeOf(tierRaw: unknown): ProbeState | undefined {
  if (!isPlainObject(tierRaw)) return undefined
  const p = (tierRaw as Record<string, unknown>).probe
  if (!isPlainObject(p)) return undefined
  const probe = p as Record<string, unknown>
  if (probe.status !== 'verified' && probe.status !== 'mismatch' && probe.status !== 'unverifiable') return undefined
  if (typeof probe.probedAt !== 'string') return undefined
  const out: ProbeState = { status: probe.status, probedAt: probe.probedAt }
  if (typeof probe.detail === 'string') out.detail = probe.detail
  return out
}

/**
 * Apply the envelope patch discipline to a mutable target: undefined field =
 * preserve, empty string = delete, else set. Shared by both backends so the
 * merge semantics stay identical across sources.
 */
export function applyEnvelopePatch(target: Record<string, unknown>, envelope: EntryEnvelope | undefined): void {
  if (envelope === undefined) return
  for (const key of ['name', 'description', 'environment'] as const) {
    const value = envelope[key]
    if (value === undefined) continue
    if (value === '') delete target[key]
    else target[key] = value
  }
}

/** Merge an envelope patch over an existing envelope, returning the result (hub backend variant). */
export function mergeEnvelope(existing: EntryEnvelope, patch: EntryEnvelope | undefined): EntryEnvelope {
  const target: Record<string, unknown> = { ...existing }
  applyEnvelopePatch(target, patch)
  return buildEnvelope([target])
}

// ── Backend contract ─────────────────────────────────────────────────────────

/** Tier presence + probe for the fields-free listing view. */
export interface BackendTierStatus {
  probe?: ProbeState
}

/** One entry in the fields-free listing view (listAll, resolve error hints). */
export interface BackendEntry {
  kind: string
  name: string
  envelope: EntryEnvelope
  tiers: { ro?: BackendTierStatus, rw?: BackendTierStatus }
}

/** One tier's raw data: provider-shaped fields (file fields are LOCAL PATHS) + envelope + probe. */
export interface BackendTier {
  fields: Record<string, unknown>
  envelope: EntryEnvelope
  probe?: ProbeState
}

/** Thrown when the source itself is unavailable (yaml: registry file missing) — resolve surfaces it verbatim. */
export class SourceUnavailableError extends Error {}

export interface AccessBackend {
  /**
   * Human phrase for error messages, used as `in ${label}`: yaml →
   * `registry file <path>`, hub → `access hub at <url>`.
   */
  readonly label: string
  /**
   * The fields-free listing of every entry: envelope + tier presence +
   * probes. A missing source yields an empty list; an unreadable/corrupt
   * source THROWS (callers pick their own degrade discipline, matching the
   * pre-backend behavior per method).
   */
  listEntries(): Promise<BackendEntry[]>
  /**
   * One tier's provider-shaped fields + envelope. Null when the entry or the
   * tier does not exist. Throws SourceUnavailableError when the source
   * itself is missing, and rethrows read/parse failures.
   *
   * `materialize` (default true) matters only for the hub backend: true
   * writes fetched file-field contents to managed local files (resolve —
   * the credential is being issued); false substitutes the would-be managed
   * path WITHOUT touching disk (canResolve/list/getEntry — metadata reads
   * must not write secret material, e.g. the gate's pre-approval check).
   */
  loadTier(kind: string, name: string, tier: 'ro' | 'rw', opts?: { materialize?: boolean }): Promise<BackendTier | null>
  /**
   * Persist one tier. `fields` is provider-shaped (file fields are local
   * paths — the hub backend reads their content and uploads THAT; paths
   * never leave the machine). `envelope` follows the patch discipline
   * (undefined = preserve, '' = delete). `probe`, when given, is stored
   * beside the tier.
   */
  putTier(kind: string, name: string, tier: 'ro' | 'rw', fields: Record<string, unknown>, envelope: EntryEnvelope | undefined, probe?: ProbeState): Promise<void>
  /**
   * Remove one tier. Returns 'missing' when the entry did not exist, 'tier'
   * when the tier is gone but the entry survives, 'entry' when the last
   * tier went and the whole entry was dropped. (A tier that was already
   * absent on an existing entry reports as if deleted — the pre-backend
   * deleteEntry answered true for an existing entry regardless.)
   */
  deleteTier(kind: string, name: string, tier: 'ro' | 'rw'): Promise<'missing' | 'tier' | 'entry'>
}

// ── YAML registry backend ────────────────────────────────────────────────────

/** Parsed registry: kind section → profile name → raw entry. */
type Registry = Record<string, Record<string, unknown>>

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

/** Serialize a registry back to its YAML file with the version header. */
async function saveRegistry(file: string, registry: Registry): Promise<void> {
  const doc: Record<string, unknown> = { version: 1 }
  for (const [kind, section] of Object.entries(registry)) {
    doc[kind] = section
  }
  await writeFile(file, stringifyYaml(doc), 'utf8')
}

/**
 * The original local YAML registry. Every operation re-reads (and writes
 * back) the whole file — edits take effect immediately, nothing is cached.
 * Sections whose kind has no registered provider are preserved untouched.
 */
export class YamlBackend implements AccessBackend {
  readonly label: string

  constructor(readonly registryFile: string) {
    this.label = `registry file ${registryFile}`
  }

  async listEntries(): Promise<BackendEntry[]> {
    const registry = await loadRegistry(this.registryFile)
    if (registry === null) return []
    const result: BackendEntry[] = []
    for (const kind of Object.keys(registry).sort()) {
      const section = registry[kind]
      for (const name of Object.keys(section).sort()) {
        const entry = section[name]
        if (!isPlainObject(entry)) continue
        const raw = entry as Record<string, unknown>
        const tiers: BackendEntry['tiers'] = {}
        if (isPlainObject(raw.ro)) tiers.ro = { ...(probeOf(raw.ro) !== undefined ? { probe: probeOf(raw.ro) } : {}) }
        if (isPlainObject(raw.rw)) tiers.rw = { ...(probeOf(raw.rw) !== undefined ? { probe: probeOf(raw.rw) } : {}) }
        result.push({ kind, name, envelope: buildEnvelope([raw]), tiers })
      }
    }
    return result
  }

  async loadTier(kind: string, name: string, tier: 'ro' | 'rw'): Promise<BackendTier | null> {
    const registry = await loadRegistry(this.registryFile)
    if (registry === null) {
      throw new SourceUnavailableError(`ops-access: registry file not found: ${this.registryFile}`)
    }
    const entry = registry[kind]?.[name]
    if (!isPlainObject(entry)) return null
    const raw = entry[tier]
    if (!isPlainObject(raw)) return null
    const fields: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
    const probe = probeOf(raw)
    delete fields.probe
    return { fields, envelope: buildEnvelope([entry as Record<string, unknown>]), ...(probe !== undefined ? { probe } : {}) }
  }

  async putTier(kind: string, name: string, tier: 'ro' | 'rw', fields: Record<string, unknown>, envelope: EntryEnvelope | undefined, probe?: ProbeState): Promise<void> {
    // Read → merge → write back. A missing file starts from an empty
    // registry; an unparseable file throws (we will not overwrite a file we
    // cannot read).
    let registry: Registry = {}
    const loaded = await loadRegistry(this.registryFile)
    if (loaded !== null) registry = loaded
    if (!registry[kind]) registry[kind] = {}
    if (!isPlainObject(registry[kind][name])) registry[kind][name] = {}
    const entry = registry[kind][name] as Record<string, unknown>
    const tierData: Record<string, unknown> = { ...fields }
    if (probe !== undefined) tierData.probe = probe
    entry[tier] = tierData
    applyEnvelopePatch(entry, envelope)
    await saveRegistry(this.registryFile, registry)
  }

  async deleteTier(kind: string, name: string, tier: 'ro' | 'rw'): Promise<'missing' | 'tier' | 'entry'> {
    const registry = await loadRegistry(this.registryFile)
    if (registry === null) return 'missing'
    const section = registry[kind]
    if (!section || !(name in section)) return 'missing'
    const entry = section[name]
    if (!isPlainObject(entry)) return 'missing'
    delete (entry as Record<string, unknown>)[tier]
    // If neither tier remains, drop the whole entry and empty sections.
    const remaining = ['ro', 'rw'].filter((t) => (entry as Record<string, unknown>)[t] !== undefined)
    if (remaining.length > 0) {
      await saveRegistry(this.registryFile, registry)
      return 'tier'
    }
    delete section[name]
    if (Object.keys(section).length === 0) delete registry[kind]
    await saveRegistry(this.registryFile, registry)
    return 'entry'
  }
}
