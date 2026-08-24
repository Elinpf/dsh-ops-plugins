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

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access'

export const inject: string[] = []

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  /** Path to the YAML access registry; a leading `~` expands to $HOME. */
  registryFile: string
}

export const Config: z<Config> = z.object({
  registryFile: z.string().default('~/.dsh-ops/access.yaml'),
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

/** The ops access handle exposed via ctx.get('opsAccess'). */
export interface OpsAccess {
  /** Register a credential-kind provider. Throws if the kind is already registered. Returns a disposer. */
  register(provider: AccessProvider): () => void
  /** Resolve one profile by kind and name. Throws on unknown kind, unknown name, or invalid entry. */
  resolve(kind: string, name: string): Promise<AccessProfile>
  /** List all profiles across all registered kinds. Sections without a registered provider are skipped. */
  list(): Promise<AccessProfile[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsAccess?: OpsAccess
  }
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

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const file = expandHome(config.registryFile)
  const providers = new Map<string, AccessProvider>()

  const handle: OpsAccess = {
    register(provider: AccessProvider): () => void {
      if (providers.has(provider.kind)) {
        throw new Error(`ops-access: provider for kind "${provider.kind}" is already registered`)
      }
      providers.set(provider.kind, provider)
      return () => { providers.delete(provider.kind) }
    },

    async resolve(kind: string, profileName: string): Promise<AccessProfile> {
      const provider = providers.get(kind)
      if (!provider) {
        const registered = [...providers.keys()].sort()
        throw new Error(`ops-access: unknown kind "${kind}" (no provider registered; registered kinds: ${registered.join(', ') || '(none)'})`)
      }
      const registry = await loadRegistry(file)
      if (registry === null) {
        throw new Error(`ops-access: registry file not found: ${file}`)
      }
      const section = registry[kind]
      const entry = section?.[profileName]
      if (entry === undefined) {
        const available = Object.keys(section ?? {}).sort()
        throw new Error(`ops-access: no profile "${profileName}" for kind "${kind}" in registry file ${file} (available: ${available.join(', ') || '(none)'})`)
      }
      return buildProfile(provider, kind, profileName, entry, file)
    },

    async list(): Promise<AccessProfile[]> {
      const registry = await loadRegistry(file)
      if (registry === null) return []
      const profiles: AccessProfile[] = []
      for (const [kind, section] of Object.entries(registry)) {
        // Sections whose kind has no registered provider are skipped —
        // an unrecognized kind must not fail the whole listing.
        const provider = providers.get(kind)
        if (!provider) continue
        for (const [profileName, entry] of Object.entries(section)) {
          profiles.push(buildProfile(provider, kind, profileName, entry, file))
        }
      }
      return profiles
    },
  }

  ctx.provide('opsAccess', handle)
}
