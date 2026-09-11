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

import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
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
  /**
   * Cache root for materialized credential files (already `~`-expanded).
   * Deliberately NOT the yaml mode's credentialsDir: hub-mode local files are
   * a TTL-bound cache, never permanent copies, and the sweeper must never
   * touch files the yaml registry still references (the documented fallback).
   */
  cacheDir: string
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

/**
 * Delete materialized credential files older than maxAgeMs under
 * credentialsDir (pass 0 to sweep everything), then remove the directories
 * left empty. In hub mode every local credential file is a TTL-bound cache
 * of hub content — never a permanent copy: resolve re-materializes on demand
 * (writeIfChanged), so deletion is always safe and transparent to consumers.
 * Best-effort: individual failures are skipped, the next sweep retries.
 * Returns the number of files removed.
 */
export async function sweepMaterialized(credentialsDir: string, maxAgeMs: number): Promise<number> {
  const now = Date.now()
  let removed = 0
  const walk = async (dir: string, isRoot: boolean): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // missing/unreadable dir — nothing to sweep
    }
    for (const entry of entries) {
      const p = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(p, false)
      } else {
        const st = await stat(p).catch(() => null)
        if (!st || !st.isFile()) continue
        if (maxAgeMs > 0 && now - st.mtimeMs <= maxAgeMs) continue
        await rm(p, { force: true }).catch(() => {})
        removed++
      }
    }
    // Prune emptied dirs on the way up (rmdir refuses non-empty — a
    // concurrent materialization racing the sweep is never harmed).
    if (!isRoot) await rmdir(dir).catch(() => {})
  }
  await walk(credentialsDir, true)
  return removed
}

/** Sanitize one entry of the hub's GET /entries response (durable boundary). */function sanitizeEntry(raw: unknown): BackendEntry | null {
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
      const target = `${this.opts.cacheDir}/${kind}/${name}/${tier}/${ff}`
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

  // ── Registration-request queue (hub-only, not part of AccessBackend) ──────
  // The agent-facing rw write path: submit a request, a human approves it in
  // the admin UI, and only then does the hub write the tier. Fields carry
  // CONTENT here (the agent pastes secret material directly — there is no
  // local staging file on this path).

  async submitRequest(req: { kind: string; name: string; tier: 'ro' | 'rw'; fields: Record<string, unknown>; envelope?: EntryEnvelope; reason?: string }): Promise<string> {
    const data = await this.request('POST', '/requests', {
      kind: req.kind,
      name: req.name,
      tier: req.tier,
      fields: req.fields,
      ...(req.envelope !== undefined ? { envelope: req.envelope } : {}),
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
    }, true)
    if (!isPlainObject(data) || typeof data.id !== 'string') {
      throw new Error(`ops-access: ${this.label} returned a malformed request id`)
    }
    return data.id
  }

  /** Pending-request metadata for the approval UI — field values never cross. */
  async listRequests(status?: 'pending' | 'approved' | 'rejected'): Promise<unknown> {
    return this.request('GET', status === undefined ? '/requests' : `/requests?status=${status}`)
  }

  /** Full request incl. field values, for pre-approval review. Null when absent. */
  async getRequest(id: string): Promise<unknown> {
    return this.request('GET', `/requests/${encodeURIComponent(id)}`, undefined, true)
  }

  /** Approve (hub writes the tier) or reject. Returns false when already settled/absent. */
  async decideRequest(id: string, approved: boolean): Promise<boolean> {
    const data = await this.request('POST', `/requests/${encodeURIComponent(id)}/decide`, { approved }, true)
    return data !== null
  }
}
