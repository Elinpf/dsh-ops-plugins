/**
 * Import an existing ops-access YAML registry into the hub.
 *
 * Registry format (see `@elinpf/dsh-ops-access`): `version: 1` at the top;
 * every other top-level key is a kind; keys inside a kind are profile names;
 * an entry carries optional envelope fields (`name` / `description` /
 * `environment`) and `ro` / `rw` tier sub-objects holding the fields.
 *
 * Conversion rule: within a tier, a field whose value is a single-line
 * string starting with `/`, `~/`, `./` or `../` is treated as a file path;
 * when it points at a readable file the value is replaced by the file's
 * content (the hub stores content, not paths). A path-shaped value that
 * cannot be read aborts the import with an error naming the entry and
 * field. All other values pass through unchanged. Relative paths resolve
 * against the registry file's directory; `~` expands to `$HOME`.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { EntryEnvelope, HubStore, ProbeState, TierName } from './store.js'
import { NAME_PATTERN } from './store.js'

export interface ImportedEntry {
  kind: string
  name: string
  envelope: EntryEnvelope
  tiers: { ro?: { fields: Record<string, unknown>; probe?: ProbeState }; rw?: { fields: Record<string, unknown>; probe?: ProbeState } }
}

export interface ImportStats {
  entries: number
  tiers: number
  /** Tier fields whose path value was replaced by file content. */
  fileFields: number
}

export interface ImportResult {
  entries: ImportedEntry[]
  stats: ImportStats
}

const PATH_PREFIX = /^(\/|~\/|\.\/|\.\.\/)/

/** A value is path-shaped when it is a single-line string with a path prefix. */
function looksLikePath(v: unknown): v is string {
  return typeof v === 'string' && !v.includes('\n') && PATH_PREFIX.test(v)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse and convert a registry file. Throws on malformed YAML or an unreadable path-shaped field. */
export async function importRegistry(registryFile: string): Promise<ImportResult> {
  const doc: unknown = parseYaml(await readFile(registryFile, 'utf8'))
  if (!isPlainObject(doc)) throw new Error(`import: ${registryFile} is not a YAML mapping`)
  const baseDir = dirname(resolve(registryFile))
  const entries: ImportedEntry[] = []
  const stats: ImportStats = { entries: 0, tiers: 0, fileFields: 0 }

  for (const [kind, section] of Object.entries(doc)) {
    if (kind === 'version') continue
    if (!isPlainObject(section)) throw new Error(`import: kind '${kind}' is not a mapping`)
    for (const [name, rawEntry] of Object.entries(section)) {
      if (!isPlainObject(rawEntry)) throw new Error(`import: entry '${kind}/${name}' is not a mapping`)
      const envelope: EntryEnvelope = {}
      if (typeof rawEntry.name === 'string') envelope.name = rawEntry.name
      if (typeof rawEntry.description === 'string') envelope.description = rawEntry.description
      if (typeof rawEntry.environment === 'string') envelope.environment = rawEntry.environment

      const entry: ImportedEntry = { kind, name, envelope, tiers: {} }
      for (const tier of ['ro', 'rw'] as TierName[]) {
        const rawTier = rawEntry[tier]
        if (rawTier === undefined) continue
        if (!isPlainObject(rawTier)) throw new Error(`import: tier '${kind}/${name} ${tier}' is not a mapping`)
        // The auto-managed `probe` key rides BESIDE the fields in the
        // registry (written at save time by the access probe) — lift it to
        // the tier level instead of importing it as a field.
        const { probe: rawProbe, ...rawFields } = rawTier
        const probe = isPlainObject(rawProbe) ? (rawProbe as unknown as ProbeState) : undefined
        const fields: Record<string, unknown> = {}
        for (const [field, value] of Object.entries(rawFields)) {
          if (looksLikePath(value)) {
            const expanded = value.startsWith('~') ? os.homedir() + value.slice(1) : value
            const filePath = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded)
            try {
              fields[field] = await readFile(filePath, 'utf8')
            } catch (err) {
              throw new Error(
                `import: cannot read file field '${kind}/${name} ${tier}.${field}' (${filePath}): ${(err as Error).message}`,
              )
            }
            stats.fileFields++
          } else {
            fields[field] = value
          }
        }
        entry.tiers[tier] = probe !== undefined ? { fields, probe } : { fields }
        stats.tiers++
      }
      entries.push(entry)
      stats.entries++
    }
  }
  return { entries, stats }
}

/** Push imported entries into a running hub over HTTP (one PUT per tier). */
export async function pushToHub(hubUrl: string, adminToken: string, entries: ImportedEntry[]): Promise<void> {
  const base = hubUrl.replace(/\/+$/, '')
  for (const entry of entries) {
    for (const tier of ['ro', 'rw'] as TierName[]) {
      const tierData = entry.tiers[tier]
      if (!tierData) continue
      const url = `${base}/entries/${encodeURIComponent(entry.kind)}/${encodeURIComponent(entry.name)}/${tier}`
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ fields: tierData.fields, envelope: entry.envelope, ...(tierData.probe !== undefined ? { probe: tierData.probe } : {}) }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
        throw new Error(`import: PUT ${entry.kind}/${entry.name} ${tier} failed (${res.status}): ${body?.error ?? res.statusText}`)
      }
    }
  }
}

/** Write imported entries directly into a store (offline mode; caller owns init/save). */
export function applyToStore(store: HubStore, entries: ImportedEntry[]): void {
  for (const entry of entries) {
    // Same charset rule as the HTTP surface (spec 0006): an offline import
    // bypasses segment(), so a hand-edited registry could otherwise smuggle
    // a name the API can neither resolve nor delete into the store.
    for (const [what, value] of [['kind', entry.kind], ['name', entry.name]] as const) {
      if (!NAME_PATTERN.test(value)) throw new Error(`import: invalid ${what} ${JSON.stringify(value)}: must match ${NAME_PATTERN.source}`)
    }
    for (const tier of ['ro', 'rw'] as TierName[]) {
      const tierData = entry.tiers[tier]
      if (!tierData) continue
      store.putTier(entry.kind, entry.name, tier, { fields: tierData.fields, envelope: entry.envelope, ...(tierData.probe !== undefined ? { probe: tierData.probe } : {}) })
    }
  }
}
