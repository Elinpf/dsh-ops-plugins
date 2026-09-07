/**
 * Hub backend: fetch credentials from a remote ops-access-hub service.
 *
 * The hub stores file-field CONTENT; this backend converts at the boundary:
 *
 * - `loadTier` downloads the tier's fields and MATERIALIZES each declared
 *   file field to a managed local file (`<credentialsDir>/<kind>/<name>/<tier>/<field>`,
 *   0600, atomic write, skipped when the content is unchanged), substituting
 *   the local path — so downstream consumers (kubectl/ssh CLIs, provider
 *   schemas, probes) see exactly the same provider-shaped profile the YAML
 *   backend serves, and secret paths never leave the machine.
 * - `putTier` reads the managed local files back and uploads their CONTENT
 *   (the write path — register_access, the admin UI — stages content files
 *   locally first, exactly as in YAML mode).
 *
 * Every call hits the hub — nothing is cached, mirroring the YAML backend's
 * re-read-on-every-call discipline. Listing and metadata reads never carry
 * field values; secret content crosses the wire only on the resolve and
 * write paths, over the operator-managed channel (the hub binds loopback or
 * sits behind a TLS-terminating reverse proxy).
 *
 * @module @elinpf/dsh-ops-access/hub-backend
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import os from 'node:os'
import type { AccessProvider, EntryEnvelope, ProbeState } from './types.js'
import type { AccessBackend, BackendEntry, BackendTier } from './backend.js'
import { buildEnvelope, isPlainObject, mergeEnvelope, probeOf } from './backend.js'

export interface HubBackendOptions {
  /** Hub base URL, trailing slashes stripped (e.g. `http://127.0.0.1:3090`). */
  baseUrl: string
  /** Bearer token for reads (resolve/list); empty = anonymous. */
  readToken: string
  /** Bearer token for writes (put/delete); empty = anonymous. */
  adminToken: string
  /** Managed credential file root (already `~`-expanded). */
  credentialsDir: string
  /** Provider lookup — file-field declarations drive the content ↔ path conversion. */
  getProvider: (kind: string) => AccessProvider | undefined
}

/** Expand a leading `~` (or `~/`) to the user's home directory. */
function expandHome(p: string): string {
  const home = process.env.HOME ?? os.homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p
}

/**
 * Write content to a managed file, skipping the write when the on-disk
 * bytes already match (resolve runs on every tool call — touching the file
 * every time would churn mtimes and race concurrent writers). Atomic via
 * write-temp-then-rename; mode 0600 — the file carries secret material.
 */
async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await readFile(filePath, 'utf8')) === content) return
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, filePath)
}

/** Sanitize one entry of the hub's GET /entries response (durable boundary). */
function sanitizeEntry(raw: unknown): BackendEntry | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.kind !== 'string' || typeof raw.name !== 'string') return null
  const tiers: BackendEntry['tiers'] = {}
  if (isPlainObject(raw.tiers)) {
    for (const tier of ['ro', 'rw'] as const) {
      const t = raw.tiers[tier]
      if (t === undefined || t === null) continue
      const probe = probeOf(t)
      tiers[tier] = probe !== undefined ? { probe } : {}
    }
  }
  return { kind: raw.kind, name: raw.name, envelope: buildEnvelope([isPlainObject(raw.envelope) ? raw.envelope : undefined]), tiers }
}

export class HubBackend implements AccessBackend {
  readonly label: string

  constructor(private readonly opts: HubBackendOptions) {
    this.label = `access hub at ${opts.baseUrl}`
  }

  /**
   * One HTTP call. Returns null on 404; throws on every other failure with
   * the hub's error message (which never carries field values). The auth
   * token rides an Authorization header and never lands in error text.
   */
  private async request(method: string, path: string, body?: unknown, admin = false): Promise<unknown> {
    const token = admin ? this.opts.adminToken : this.opts.readToken
    let res: Response
    try {
      res = await fetch(this.opts.baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token !== '' ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err: any) {
      throw new Error(`ops-access: cannot reach ${this.label}: ${err?.message ?? err}`)
    }
    if (res.status === 404) return null
    const text = await res.text()
    let parsed: unknown = null
    if (text !== '') {
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`ops-access: ${this.label} returned a non-JSON response (${res.status})`)
      }
    }
    if (!res.ok) {
      const message = isPlainObject(parsed) && typeof parsed.error === 'string' ? parsed.error : res.statusText
      throw new Error(`ops-access: ${this.label} rejected ${method} ${path} (${res.status}): ${message}`)
    }
    return parsed
  }

  async listEntries(): Promise<BackendEntry[]> {
    const data = await this.request('GET', '/entries')
    if (!Array.isArray(data)) return []
    return data
      .map(sanitizeEntry)
      .filter((e): e is BackendEntry => e !== null)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  }

  async loadTier(kind: string, name: string, tier: 'ro' | 'rw', loadOpts?: { materialize?: boolean }): Promise<BackendTier | null> {
    const data = await this.request('GET', `/entries/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/${tier}`)
    if (data === null || !isPlainObject(data) || !isPlainObject(data.fields)) return null
    const fields: Record<string, unknown> = { ...(data.fields as Record<string, unknown>) }
    const provider = this.opts.getProvider(kind)
    const materialize = loadOpts?.materialize !== false
    // File fields arrive as CONTENT; substitute the managed local path,
    // writing the file only when the credential is actually being issued
    // (materialize) — metadata reads must not persist secret material.
    for (const ff of provider?.fileFields ?? []) {
      const content = fields[ff]
      if (typeof content !== 'string' || content === '') continue
      const target = `${this.opts.credentialsDir}/${kind}/${name}/${tier}/${ff}`
      if (materialize) await writeIfChanged(target, content)
      fields[ff] = target
    }
    const probe = probeOf(data)
    return {
      fields,
      envelope: buildEnvelope([isPlainObject(data.envelope) ? data.envelope : undefined]),
      ...(probe !== undefined ? { probe } : {}),
    }
  }

  async putTier(kind: string, name: string, tier: 'ro' | 'rw', fields: Record<string, unknown>, envelope: EntryEnvelope | undefined, probe?: ProbeState): Promise<void> {
    const provider = this.opts.getProvider(kind)
    const out: Record<string, unknown> = { ...fields }
    // Paths → content: the hub stores the secret material itself. An
    // unreadable managed file fails loud — a half-written credential on the
    // hub is worse than no write.
    for (const ff of provider?.fileFields ?? []) {
      const value = out[ff]
      if (typeof value !== 'string' || value === '') continue
      const source = expandHome(value)
      try {
        out[ff] = await readFile(source, 'utf8')
      } catch (err: any) {
        throw new Error(`ops-access: cannot read credential file ${source} for upload to the hub: ${err?.message ?? err}`)
      }
    }
    // Envelope merge needs the entry's current envelope (the hub replaces it
    // wholesale); the fields-free listing carries it.
    const entries = await this.listEntries().catch(() => [] as BackendEntry[])
    const existing = entries.find((e) => e.kind === kind && e.name === name)
    const merged = mergeEnvelope(existing?.envelope ?? {}, envelope)
    await this.request('PUT', `/entries/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/${tier}`, {
      fields: out,
      envelope: merged,
      ...(probe !== undefined ? { probe } : {}),
    }, true)
  }

  async deleteTier(kind: string, name: string, tier: 'ro' | 'rw'): Promise<'missing' | 'tier' | 'entry'> {
    const res = await this.request('DELETE', `/entries/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/${tier}`, undefined, true)
    if (res === null) return 'missing'
    // Whether the whole entry went with the tier decides the managed-dir
    // cleanup scope — re-list and look.
    const entries = await this.listEntries().catch(() => [] as BackendEntry[])
    return entries.some((e) => e.kind === kind && e.name === name) ? 'tier' : 'entry'
  }
}
