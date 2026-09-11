/**
 * Ops access capability seam.
 *
 * Exposes `ctx.opsAccess`: a generic `resolve(kind, name)` / `list()` entry
 * plus a `register(provider)` surface for provider plugins. Providers (one
 * per credential kind) supply the zod schema for their entry shape and an
 * optional `process` step (e.g. `~` expansion); profiles carry only paths
 * and connection params, never inline secret material.
 *
 * The credential SOURCE is pluggable (see backend.ts):
 * - 'yaml' (default) owns the local YAML registry file
 *   (`~/.dsh-ops/access.yaml`), re-read, re-parsed, and re-validated on
 *   every call — edits take effect immediately, nothing is cached.
 * - 'hub' fetches entries from a remote ops-access-hub service on every
 *   call (hub-backend.ts): file-field CONTENT is materialized to managed
 *   local files at resolve time, so profiles still carry only paths.
 *
 * Also registers the `register_access` tool: the agent's self-service path
 * for writing the ro tier of a profile. rw tiers stay human-approved — the
 * tool can only QUEUE an rw registration request on the hub (hub mode);
 * a human approves it in the admin UI before anything is written.
 *
 * Registry format (yaml source):
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
 * @module @elinpf/dsh-ops-access
 */

import { readFile, writeFile, mkdir, rm, rmdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatAccessMention, parseAccessReferenceText } from './mention.js'
import type { ParsedAccessReference } from './mention.js'
import type {
  AccessProvider,
  AccessProfile,
  EntryEnvelope,
  ProbeState,
  AdminTierStatus,
  AdminEntry,
  KindDescriptor,
  AccessAgent,
  AccessBroker,
  OpsAccess,
} from './types.js'
import type { AccessBackend, BackendEntry, BackendTier } from './backend.js'
import { YamlBackend, buildEnvelope, isPlainObject } from './backend.js'
import { HubBackend, sweepMaterialized } from './hub-backend.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access'

export const inject = ['tools']

// ── Config ───────────────────────────────────────────────────────────────────

// The Config interface stays here (not in types.ts): it declaration-merges
// with the schemastery schema const below, and TS rejects merging a local
// const with a type re-exported from another module. types.ts re-exports it
// so the `./types` subpath still carries the full type set.
export interface Config {
  /** Path to the YAML access registry; a leading `~` expands to $HOME. (source: 'yaml') */
  registryFile: string
  /** Root directory for managed credential content files; a leading `~` expands to $HOME. */
  credentialsDir: string
  /**
   * Credential source: 'yaml' (default) reads the local registry file;
   * 'hub' fetches entries from a remote ops-access-hub service on every
   * call and materializes file-field content to managed local files.
   */
  source?: 'yaml' | 'hub'
  /** Hub base URL (source: 'hub'), e.g. http://127.0.0.1:3090. */
  hubUrl?: string
  /** Hub read token (source: 'hub'); falls back to env ACCESS_HUB_READ_TOKEN. Never logged. */
  hubToken?: string
  /** Hub admin token for write/delete (source: 'hub'); falls back to env ACCESS_HUB_ADMIN_TOKEN. Never logged. */
  hubAdminToken?: string
  /**
   * Minutes a materialized credential file may linger on this host (source:
   * 'hub'). Materialized files are a TTL-bound cache of hub content, never a
   * permanent copy — resolve re-materializes on demand, so expiry is
   * transparent to consumers. Startup sweeps everything (a restart clears
   * the grant ledger; cached rw material must not outlive it).
   */
  materializeTtlMinutes?: number
  /**
   * Cache root for hub-mode materialized files (source: 'hub'; default
   * `~/.dsh-ops/hub-cache`). Deliberately separate from credentialsDir: the
   * sweeper only ever walks this dir, so files the yaml registry references
   * (the documented fallback) are never touched.
   */
  hubCacheDir?: string
}

export const Config: z<Config> = z.object({
  registryFile: z.string().default('~/.dsh-ops/access.yaml'),
  credentialsDir: z.string().default('~/.dsh-ops/credentials'),
  source: z.union(['yaml', 'hub']).default('yaml'),
  hubUrl: z.string().default(''),
  hubToken: z.string().default(''),
  hubAdminToken: z.string().default(''),
  materializeTtlMinutes: z.number().default(15),
  hubCacheDir: z.string().default('~/.dsh-ops/hub-cache'),
})

// ── Service contract ─────────────────────────────────────────────────────────

// The service contract types (AccessProvider, AccessProfile, EntryEnvelope,
// ProbeState, the admin-view types, KindDescriptor, the broker types,
// OpsAccess) and the Config interface live in ./types.js — a types-only
// module. This re-export keeps existing `from '@elinpf/dsh-ops-access'`
// type imports working.
export type {
  AccessProvider,
  AccessProfile,
  EntryEnvelope,
  ProbeState,
  AdminTierStatus,
  AdminEntry,
  KindDescriptor,
  AccessAgent,
  AccessBrokerDecision,
  AccessBroker,
  OpsAccess,
} from './types.js'

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

/**
 * Validate one tier sub-object against the provider schema and build the
 * profile. `raw` carries only the provider fields; the envelope
 * (description/environment) lives on the parent entry and is passed separately.
 * `source` is the backend's label phrase (e.g. `registry file <path>` /
 * `access hub at <url>`), interpolated as `in ${source}` in error messages.
 */
function buildProfile(provider: AccessProvider, kind: string, profileName: string, tier: 'ro' | 'rw', raw: unknown, source: string, parentEntry?: EntryEnvelope): AccessProfile {
  if (!isPlainObject(raw)) {
    throw new Error(`ops-access: entry ${kind}.${profileName} in ${source} must be a mapping`)
  }
  const result = provider.schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`ops-access: invalid entry ${kind}.${profileName} in ${source}: ${issues}`)
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

/**
 * The final step of building a profile: expand the provider's declared
 * reference fields through the SAME backend and tier, then run the
 * provider's post-merge validation. Referenced fields are merged UNDER the
 * referring entry's (the referring entry wins conflicts — e.g. a per-host
 * user override of a shared credential's default user). One level only: a
 * referenced entry's own reference fields are not expanded. The broker is
 * NOT consulted for the reference — it is an implementation detail of the
 * referring resolve, which was already gated.
 *
 * References load through the backend (`loadTier`), so in hub mode the
 * referenced credential's file-field content is fetched and materialized by
 * the same machinery as a direct resolve — `materialize` propagates the
 * caller's intent (resolve issues credentials → write the files; canResolve/
 * list are metadata reads → paths only, nothing touches disk). Shared by
 * resolve, canResolve, and list so all three see the same resolved shape.
 */
async function finalizeProfile(
  backend: AccessBackend,
  providers: ReadonlyMap<string, AccessProvider>,
  provider: AccessProvider,
  profile: AccessProfile,
  opts: { materialize: boolean },
): Promise<AccessProfile> {
  if (provider.references) {
    const merged: Record<string, unknown> = {}
    let any = false
    for (const [field, refKind] of Object.entries(provider.references)) {
      const refName = profile.fields[field]
      if (refName === undefined) continue
      if (typeof refName !== 'string' || refName.length === 0) {
        throw new Error(`ops-access: entry ${profile.kind}.${profile.name} ${profile.tier} field "${field}" must be a non-empty string naming a ${refKind} profile`)
      }
      const refProvider = providers.get(refKind)
      if (!refProvider) {
        throw new Error(`ops-access: entry ${profile.kind}.${profile.name} references ${refKind}/${refName}, but no provider is registered for kind "${refKind}"`)
      }
      const loaded = await backend.loadTier(refKind, refName, profile.tier, { materialize: opts.materialize })
      if (loaded === null) {
        const entries = await backend.listEntries().catch(() => [] as BackendEntry[])
        const available = entries.filter((e) => e.kind === refKind).map((e) => e.name).sort()
        throw new Error(`ops-access: entry ${profile.kind}.${profile.name} references ${refKind}/${refName}, which has no ${profile.tier} tier in ${backend.label} (available: ${available.join(', ') || '(none)'})`)
      }
      const refProfile = buildProfile(refProvider, refKind, refName, profile.tier, loaded.fields, backend.label, loaded.envelope)
      Object.assign(merged, refProfile.fields)
      any = true
    }
    if (any) profile.fields = { ...merged, ...profile.fields }
  }
  const problem = provider.validateResolved?.(profile.fields)
  if (problem) {
    throw new Error(`ops-access: invalid entry ${profile.kind}.${profile.name} in ${backend.label}: ${problem}`)
  }
  return profile
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

/**
 * Whether a file-field value names a file instead of carrying the content:
 * a single line starting with `/`, `~/`, `./`, or `../`. Real file-field
 * content (kubeconfig, ceph.conf, keyring, private key) is always multi-line
 * structured text, so a path-shaped single line is unambiguous.
 * @param content - a file-field value already known to be a non-empty string.
 * @returns true when the value should be read from disk as a file path.
 */
function looksLikeFilePath(content: string): boolean {
  return !content.includes('\n') && /^(?:\/|~\/|\.{1,2}\/)/.test(content)
}

async function writeContentFiles(credentialsDir: string, kind: string, profileName: string, tier: string, fileFields: readonly string[], contentFiles: Record<string, unknown>, entryFields: Record<string, unknown>, provider?: AccessProvider): Promise<string[]> {
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
    // A single-line value starting with a path prefix names a file to read
    // instead of the content itself — the credential then never round-trips
    // through the model request or the admin form. File-field content
    // (kubeconfig, ceph.conf, keyring, private key) is always multi-line
    // structured text, so the two never collide. A path with no file behind
    // it fails loud: the commonest mistake is passing a path where content
    // is expected.
    let resolved = content
    if (looksLikeFilePath(content)) {
      const source = content.startsWith('~/')
        ? (process.env.HOME ?? os.homedir()) + content.slice(1)
        : resolve(content)
      try {
        resolved = await readFile(source, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unreadable'
        throw new Error(`ops-access: "${fieldName}" looks like a file path, but no readable file at ${source} (${code}) — pass the full file CONTENT, or a path to an existing file`)
      }
    }
    // Provider-declared write-time normalization runs FIRST — validator
    // and disk both see the normalized bytes.
    const normalized = provider?.normalizeTrailingNewline ? resolved.replace(/[\r\n]+$/, '') + '\n' : resolved
    // Save-time content validation (provider hook, possibly async — ssh
    // runs ssh-keygen): reject corrupt pastes BEFORE anything lands on disk.
    const problem = await provider?.validateContent?.(fieldName, normalized)
    if (problem) {
      throw new Error(`ops-access: invalid content for ${kind}/${profileName} ${tier} ${fieldName}: ${problem}`)
    }
    const dir = credentialsDir + '/' + kind + '/' + profileName + '/' + tier
    await mkdir(dir, { recursive: true })
    const filePath = dir + '/' + fieldName
    await writeFile(filePath, normalized, { encoding: 'utf8', mode: 0o600 })
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
  // A listAll failure (unreadable/corrupt registry file) degrades the mention
  // render to name-only lines — the registry being temporarily unreadable must
  // not break prompt assembly for the whole turn.
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
  // Credential source backend (see backend.ts / hub-backend.ts): yaml is the
  // default and behaves byte-for-byte as before; hub fetches entries from a
  // remote ops-access-hub on every call and materializes file-field content
  // to managed local files under credentialsDir.
  const source = config.source ?? 'yaml'
  // In hub mode every local credential file — materialized reads AND staged
  // writes — lives under hubCacheDir as a TTL-bound cache. credentialsDir
  // stays yaml-mode territory: the sweeper must never touch files the yaml
  // registry still references (the documented fallback).
  const contentDir = source === 'hub' ? expandHome(config.hubCacheDir ?? '~/.dsh-ops/hub-cache') : credentialsDir
  let backend: AccessBackend
  if (source === 'hub') {
    const hubUrl = (config.hubUrl ?? '').replace(/\/+$/, '')
    if (hubUrl === '') {
      throw new Error('ops-access: source "hub" requires hubUrl (e.g. http://127.0.0.1:3090)')
    }
    backend = new HubBackend({
      baseUrl: hubUrl,
      readToken: config.hubToken || process.env.ACCESS_HUB_READ_TOKEN || '',
      adminToken: config.hubAdminToken || process.env.ACCESS_HUB_ADMIN_TOKEN || '',
      cacheDir: contentDir,
      getProvider: (kind) => providers.get(kind),
    })
    // Hub mode: local credential files are a TTL-bound cache of hub content,
    // never permanent copies. Startup sweeps EVERYTHING in the cache dir (the
    // grant ledger is in-memory and cleared by this very restart — cached rw
    // material must not outlive it); the interval sweep then expires files
    // past the TTL. Both tiers: ro cache expiry is equally transparent
    // (resolve re-fetches and re-materializes on demand). apply is sync — the
    // boot sweep runs detached; a resolve re-materializes anything it needs
    // anyway, so a slow boot sweep can only leave a stale file for seconds.
    const ttlMs = (config.materializeTtlMinutes ?? 15) * 60_000
    void sweepMaterialized(contentDir, 0).catch(() => {})
    ctx.effect(() => {
      const timer = setInterval(() => {
        void sweepMaterialized(contentDir, ttlMs).catch(() => {})
      }, Math.min(ttlMs, 60_000))
      timer.unref?.()
      return () => clearInterval(timer)
    })
  } else {
    backend = new YamlBackend(registryFile)
  }
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

    async canResolve(kind: string, profileName: string, tier: 'ro' | 'rw'): Promise<AdminTierStatus> {
      const provider = providers.get(kind)
      if (!provider) return { ok: false }
      // Load + locate the entry in its own try/catch: a missing source or
      // entry is a structural "not resolvable" with no validation reason —
      // the admin does not need a zod message to fix an entry that isn't
      // there. materialize: false — a precheck must not write secret files
      // (hub mode), e.g. the gate's pre-approval check on the rw tier.
      let loaded: BackendTier | null
      try {
        loaded = await backend.loadTier(kind, profileName, tier, { materialize: false })
      } catch {
        return { ok: false }
      }
      if (loaded === null) return { ok: false }
      // Run the same buildProfile validation resolve would run — a precheck
      // shallower than the real issuance approves grants that cannot be
      // fulfilled. The profile itself is discarded: existence, not fields.
      // Reference expansion runs too (finalizeProfile): a dangling credential
      // reference is exactly the kind of undeliverable resolve this precheck
      // exists to catch. A validation failure surfaces the reason (zod issue
      // paths + messages, never raw field values) so the admin UI can show it.
      try {
        const profile = buildProfile(provider, kind, profileName, tier, loaded.fields, backend.label, loaded.envelope)
        await finalizeProfile(backend, providers, provider, profile, { materialize: false })
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
      // A missing SOURCE (yaml: no registry file) throws from the backend
      // verbatim (SourceUnavailableError); an unreadable source propagates
      // its read/parse error the same way.
      const loaded = await backend.loadTier(kind, profileName, tier)
      if (loaded === null) {
        // Distinguish "no such entry" from "entry without this tier" via the
        // fields-free listing — the hints below guide the agent's next move.
        const entries = await backend.listEntries().catch(() => [] as BackendEntry[])
        const inKind = entries.filter((e) => e.kind === kind)
        const entry = inKind.find((e) => e.name === profileName)
        if (!entry) {
          const available = inKind.map((e) => e.name).sort()
          const hint = tier === 'rw' ? ' — a grant was approved but no rw credential is registered; ask the operator to add it via the admin UI' : ''
          throw new Error(`ops-access: no profile "${profileName}" for kind "${kind}" in ${backend.label} (available: ${available.join(', ') || '(none)'})${hint}`)
        }
        // On the rw tier the grant was already approved — say so, so the agent
        // reports "no rw credential registered" to the operator instead of
        // re-requesting a grant that can never be fulfilled. On the ro tier
        // with rw present, point at the self-service derivation path.
        const hint = tier === 'rw'
          ? ' — a grant was approved but no rw credential is registered; ask the operator to add it via the admin UI'
          : entry.tiers.rw !== undefined
            ? ' — the rw tier is registered; derive a read-only credential from it (list_access help: true has the recipe) and register it via the register_access tool'
            : ''
        throw new Error(`ops-access: no ${tier} tier for profile "${profileName}" (kind "${kind}") in ${backend.label}${hint}`)
      }
      const profile = buildProfile(provider, kind, profileName, tier, loaded.fields, backend.label, loaded.envelope)
      return finalizeProfile(backend, providers, provider, profile, { materialize: true })
    },

    async list(): Promise<AccessProfile[]> {
      // A missing source lists empty; an unreadable/corrupt source throws
      // (same discipline as the pre-backend list).
      const entries = await backend.listEntries()
      const profiles: AccessProfile[] = []
      for (const entry of entries) {
        // Kinds without a registered provider are skipped — an unrecognized
        // kind must not fail the whole listing. list() surfaces the
        // agent-readable ro tier only. materialize: false — listing is not
        // issuance; file fields carry their would-be managed path.
        const provider = providers.get(entry.kind)
        if (!provider || entry.tiers.ro === undefined) continue
        const loaded = await backend.loadTier(entry.kind, entry.name, 'ro', { materialize: false }).catch(() => null)
        if (loaded === null) continue
        const profile = buildProfile(provider, entry.kind, entry.name, 'ro', loaded.fields, backend.label, loaded.envelope)
        profiles.push(await finalizeProfile(backend, providers, provider, profile, { materialize: false }))
      }
      return profiles
    },

    help(): string {
      const lines: string[] = [
        'Ops access registry — how to manage credentials',
        '',
      ]
      if (source === 'hub') {
        lines.push(
          `Source: ${backend.label}`,
          'Entries are fetched from the hub on EVERY call — edits in the hub UI take effect immediately, no restart.',
          `File-field contents live in the hub; at resolve time they are materialized to cache files under ${contentDir} (0600, TTL-bound — swept on expiry and at startup, re-materialized on demand) and profiles carry those paths — secret material never enters logs or model context.`,
        )
      } else {
        lines.push(
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
          '        probe: {...}                            # auto-managed capability check (ticket 10): status/detail/probedAt, written at save time — do not edit',
        )
      }
      lines.push('', 'Registered kinds and their entry fields:')
      const kinds = [...providers.values()].sort((a, b) => a.kind.localeCompare(b.kind))
      if (kinds.length === 0) {
        lines.push('- (none registered)')
      }
      for (const p of kinds) {
        lines.push(`- ${p.kind}: ${p.fieldsDoc ?? '(no field docs provided by this provider)'}`)
        if (p.derivationDoc) lines.push(`  derive ro: ${p.derivationDoc}`)
      }
      lines.push('')
      lines.push('Agents register ro tiers with the register_access tool; rw tiers are human-approved — the tool can submit an rw registration REQUEST (tier: "rw") which takes effect only after an operator approves it in the admin UI (hub mode).')
      lines.push('Registering: pass the full file CONTENT for file fields, or a single-line path to an existing readable file (read server-side, content never passes through the model). Multi-line pastes are always treated as content.')
      lines.push('In the REGISTRY itself, file fields carry the managed file paths — secrets never go inline, so logs and model context never contain secret material.')
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
      // Validate via buildProfile BEFORE writing — a schema failure must not
      // touch the source. buildProfile throws with zod issue paths + messages,
      // never raw field values.
      const writtenProfile = buildProfile(provider, kind, profileName, tier, tierData, backend.label)
      // Capability probe (ticket 10): verify claims against reality at save
      // time — the credential files are already on disk (the caller writes
      // them first). A probe failure degrades to 'unverifiable', never a
      // write rejection.
      let probe: ProbeState | undefined
      if (provider.probe) {
        const probed = await provider.probe(writtenProfile.fields, tier)
          .catch((err: unknown) => ({
            status: 'unverifiable' as const,
            detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
          }))
        probe = { ...probed, probedAt: new Date().toISOString() }
      }
      // The backend applies the envelope patch discipline (undefined =
      // preserve, empty string = delete) and persists the tier.
      await backend.putTier(kind, profileName, tier, tierData, envelope, probe)
    },

    async deleteEntry(kind: string, profileName: string, tier: 'ro' | 'rw'): Promise<boolean> {
      const outcome = await backend.deleteTier(kind, profileName, tier)
      if (outcome === 'missing') return false
      // Remove the tier's managed credential files; when the whole entry
      // went, remove its credential directory too. (contentDir: the hub cache
      // in hub mode, the yaml-mode managed dir otherwise.)
      const provider = providers.get(kind)
      if (provider?.fileFields && provider.fileFields.length > 0) {
        await rm(contentDir + '/' + kind + '/' + profileName + '/' + tier, { recursive: true, force: true })
        if (outcome === 'entry') {
          await rm(contentDir + '/' + kind + '/' + profileName, { recursive: true, force: true })
        }
      }
      return true
    },

    async listAll(): Promise<AdminEntry[]> {
      // A source failure degrades to an empty list — canResolve reports the
      // failure per tier.
      let entries: BackendEntry[] = []
      try { entries = await backend.listEntries() } catch { /* canResolve reports the failure */ }
      const result: AdminEntry[] = []
      for (const entry of entries) {
        if (!providers.has(entry.kind)) continue
        const roStatus = await handle.canResolve(entry.kind, entry.name, 'ro')
        const rwStatus = await handle.canResolve(entry.kind, entry.name, 'rw')
        if (entry.tiers.ro?.probe !== undefined) roStatus.probe = entry.tiers.ro.probe
        if (entry.tiers.rw?.probe !== undefined) rwStatus.probe = entry.tiers.rw.probe
        result.push({ kind: entry.kind, name: entry.name, envelope: entry.envelope, tiers: { ro: roStatus, rw: rwStatus } })
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
      let loaded: BackendTier | null
      try {
        loaded = await backend.loadTier(kind, profileName, tier, { materialize: false })
      } catch {
        // Source unreadable/corrupt → the entry is unknowable; getEntry
        // reports null (not found) rather than failing the caller's whole flow.
        return null
      }
      if (loaded === null) return null
      // Return the tier's NON-file fields plus the entry's envelope. File
      // fields (credential content) are write-only after save: content is
      // never read back — not even the managed path — only the set status
      // rides along so the UI can render "已保存，粘贴新内容以覆盖". This
      // keeps stored credentials unreachable for anyone (or anything) that
      // can merely reach the admin routes.
      const fields: Record<string, unknown> = { ...loaded.fields }
      const fileFields: Record<string, boolean> = {}
      for (const ff of provider.fileFields ?? []) {
        const stored = fields[ff]
        fileFields[ff] = typeof stored === 'string' && stored.length > 0
        delete fields[ff]
      }
      const result: { fields: Record<string, unknown>, fileFields: Record<string, boolean>, displayName?: string, description?: string, environment?: string } = { fields, fileFields }
      if (loaded.envelope.name !== undefined) result.displayName = loaded.envelope.name
      if (loaded.envelope.description !== undefined) result.description = loaded.envelope.description
      if (loaded.envelope.environment !== undefined) result.environment = loaded.envelope.environment
      return result
    },
  }

  ctx.provide('opsAccess', handle)

  // ── register_access tool (agent-facing ro writer / rw requester) ──────────
  // The agent's self-service registration path: it derives a read-only
  // credential from the rw one (per-kind recipe in the provider's
  // derivationDoc, surfaced by help()) and writes the ro tier here.
  // Deliberately ungated — the ro tier is the agent's default operating
  // level and the operator can overwrite it from the admin UI at any time.
  // The rw tier stays approval-gated: tier:"rw" only QUEUES a registration
  // request on the hub (validated like a real write); a human reviews the
  // content in the admin UI and only an approval persists the tier.
  // Tool calls sit in the session event log, so every registration and
  // request is reconstructable.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'register_access',
    description:
      'Register or overwrite the read-only (ro) credential tier of an access profile — typically a credential you derived from the rw tier (a read-only ServiceAccount token, a read-only cephx keyring, a dedicated SSH key). Pass tier: "rw" to instead SUBMIT an rw registration request for human approval (hub mode only) — it writes nothing until an operator approves it in the access admin UI. File fields (kubeconfig, conf, keyring, key) take the full file CONTENT, stored to a managed path automatically; a path to an existing readable file also works and is read server-side, so the content never needs to pass through this call. Other fields are inline values. Run list_access with help: true for per-kind field docs and derivation recipes.',
    parameters: {
      profile: { type: 'string', required: true, description: '"kind/id", e.g. "k8s/prod". The entry is created when it does not exist yet.' },
      fields: { type: 'object', additionalProperties: true, required: true, description: 'The tier field values for this kind. File fields (kubeconfig, conf, keyring, key) take the full file CONTENT — or a single-line path to an existing readable file, which is read server-side. Multi-line pastes are always treated as content.' },
      tier: { type: 'string', description: '"ro" (default) writes the read-only tier directly. "rw" does NOT write anything: in hub mode it submits a registration REQUEST that takes effect only after a human approves it in the access admin UI; in yaml mode it fails (rw stays human-managed).' },
      reason: { type: 'string', description: 'For tier "rw": why this rw credential is needed — shown to the approving human.' },
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
        return { ok: false, message: 'fields must be an object of tier field values' }
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
      // the write fails — a rejected registration must not leave orphan
      // credential files on disk.
      try {
        assertValidProfileName(profileName)
      } catch (err) {
        return { ok: false, message: String((err as Error | null)?.message ?? err) }
      }

      // ── rw tier: approval-gated registration request (hub mode only) ──────
      // Nothing is written to the credential store here. The fields are
      // validated exactly as a real write would be (staging + provider
      // content hooks + zod schema), then queued on the hub; a human reviews
      // the actual content in the admin UI and only an approval writes the
      // tier. Staging files are removed before returning either way.
      if (args.tier === 'rw') {
        if (!(backend instanceof HubBackend)) {
          return { ok: false, message: 'The rw tier is human-managed: ask the operator to register it in the admin UI (凭证管理 settings section). Agent-submitted rw registration requests require hub mode; this registry is local yaml.' }
        }
        const reason = typeof args.reason === 'string' ? args.reason : undefined
        let written: string[] = []
        try {
          if (Object.keys(contentFiles).length > 0) {
            written = await writeContentFiles(contentDir, kind, profileName, 'rw', descriptor.fileFields ?? [], contentFiles, entryFields, providers.get(kind))
          }
          const provider = providers.get(kind)!
          buildProfile(provider, kind, profileName, 'rw', entryFields, backend.label)
          // The hub stores CONTENT; convert the staged paths back.
          const requestFields: Record<string, unknown> = { ...entryFields }
          for (const ff of descriptor.fileFields ?? []) {
            const p = requestFields[ff]
            if (typeof p === 'string' && p !== '') requestFields[ff] = await readFile(expandHome(p), 'utf8')
          }
          const id = await backend.submitRequest({
            kind,
            name: profileName,
            tier: 'rw',
            fields: requestFields,
            ...(Object.keys(envelope).length > 0 ? { envelope } : {}),
            ...(reason !== undefined ? { reason } : {}),
          })
          return { ok: true, message: `rw registration request for ${kind}/${profileName} submitted (id ${id}). It takes effect ONLY after a human approves it in the access admin UI (凭证管理 settings section) — tell the operator it is waiting. Do not retry; poll list_access to see when the rw tier appears.` }
        } catch (err) {
          return { ok: false, message: `registration request failed: ${String((err as Error | null)?.message ?? err)}` }
        } finally {
          await rollbackContentFiles(contentDir, kind, profileName, 'rw', written)
        }
      }

      let written: string[] = []
      try {
        if (Object.keys(contentFiles).length > 0) {
          written = await writeContentFiles(contentDir, kind, profileName, 'ro', descriptor.fileFields ?? [], contentFiles, entryFields, providers.get(kind))
        }
        // writeEntry validates against the provider schema BEFORE touching
        // the registry; its errors carry zod issue paths + messages, never
        // raw field values.
        await handle.writeEntry(kind, profileName, 'ro', entryFields, Object.keys(envelope).length > 0 ? envelope : undefined)
      } catch (err) {
        await rollbackContentFiles(contentDir, kind, profileName, 'ro', written)
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
        // Probe verdicts ride along for ok tiers (ticket 10 review fix: the
        // @ menu is one of the three display surfaces the ticket names).
        const probeOf2 = (tiers: AdminEntry['tiers']): { ro?: string, rw?: string } | undefined => {
          const out: { ro?: string, rw?: string } = {}
          if (tiers.ro.ok && tiers.ro.probe !== undefined) out.ro = tiers.ro.probe.status
          if (tiers.rw.ok && tiers.rw.probe !== undefined) out.rw = tiers.rw.probe.status
          return Object.keys(out).length > 0 ? out : undefined
        }
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
            ...(() => { const p = probeOf2(e.tiers); return p === undefined ? {} : { probe: p } })(),
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
              writtenFiles = await writeContentFiles(contentDir, kind, name, tier, provider?.fileFields ?? [], contentFiles, entryFields, provider)
            }
            // Write-only-after-save preserve: file fields never come back
            // from the UI (getEntry withholds them), so an edit request
            // cannot carry them. Carry over the stored path for any declared
            // file field the request omits — otherwise the tier-replace
            // write would silently drop the credential. Hub mode materializes
            // the carry-over (the hub backend's putTier re-uploads file
            // CONTENT read from the path, so the file must actually exist;
            // the cache dir is TTL-bound, so this leaves no permanent copy).
            if (provider?.fileFields?.length) {
              const existing = await backend.loadTier(kind, name, tier, { materialize: source === 'hub' }).catch(() => null)
              if (existing !== null) {
                for (const ff of provider.fileFields) {
                  if (entryFields[ff] === undefined && typeof existing.fields[ff] === 'string') {
                    entryFields[ff] = existing.fields[ff]
                  }
                }
              }
            }
            const envelope = buildEnvelope([{ name: displayName, description, environment }])
            try {
              await handle.writeEntry(kind, name, tier, entryFields, Object.keys(envelope).length > 0 ? envelope : undefined)
            } catch (err) {
              await rollbackContentFiles(contentDir, kind, name, tier, writtenFiles)
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
    // ── Registration-request proxy routes (hub mode only) ──────────────────
    // The approval UI for agent-submitted rw registration requests lives in
    // the dsh settings section (ops-access-ui); these routes proxy the hub's
    // /requests API so the browser never needs the hub's admin token. Yaml
    // mode has no remote queue — the routes are simply not mounted there.
    if (backend instanceof HubBackend) {
      wctx.effect(() => (wctx as any).webServer.register({
        kind: 'exact',
        path: '/ops-access/admin/requests',
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'GET') { sendJsonError(res, 405, new Error('method not allowed')); return }
            const list = await backend.listRequests('pending')
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(list))
          } catch (err) {
            sendJsonError(res, 500, err)
          }
        },
      }))

      wctx.effect(() => (wctx as any).webServer.register({
        kind: 'exact',
        path: '/ops-access/admin/requests/detail',
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'GET') { sendJsonError(res, 405, new Error('method not allowed')); return }
            const id = new URL(req.url, 'http://localhost').searchParams.get('id')
            if (!id) { sendJsonError(res, 400, new Error('id query parameter is required')); return }
            // Full field values cross here — pre-approval review is exactly
            // the moment a human must see the secret material being asked for.
            const request = await backend.getRequest(id)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(request))
          } catch (err) {
            sendJsonError(res, 500, err)
          }
        },
      }))

      wctx.effect(() => (wctx as any).webServer.register({
        kind: 'exact',
        path: '/ops-access/admin/requests/decide',
        handler: async (req: any, res: any) => {
          try {
            if (req.method !== 'POST') { sendJsonError(res, 405, new Error('method not allowed')); return }
            const body = await readRequestBody(req)
            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(body) as Record<string, unknown>
            } catch {
              sendJsonError(res, 400, new Error('request body must be valid JSON'))
              return
            }
            if (typeof parsed.id !== 'string' || typeof parsed.approved !== 'boolean') {
              sendJsonError(res, 400, new Error('id (string) and approved (boolean) are required'))
              return
            }
            const decided = await backend.decideRequest(parsed.id, parsed.approved)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(decided ? { ok: true } : { ok: false, error: 'request not found or already decided' }))
          } catch (err) {
            sendJsonError(res, 500, err)
          }
        },
      }))
    }
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
