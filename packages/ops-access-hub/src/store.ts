/**
 * Encrypted document store for the hub.
 *
 * The whole dataset is a single JSON document (`<data-dir>/hub-data.json.enc`)
 * holding at most a few dozen entries, so it is decrypted into memory on
 * load and re-encrypted on every mutation; plaintext never touches the disk.
 * Writes are atomic: encrypt to a uniquely-named temp file in the same
 * directory, fsync it, rename over the target, then fsync the directory —
 * a power cut cannot leave a torn or zero-length data file.
 *
 * Document shape:
 *
 * ```json
 * { "version": 1, "entries": { "k8s/prod": {
 *     "kind": "k8s", "name": "prod",
 *     "envelope": { "name": "...", "description": "...", "environment": "prod" },
 *     "tiers": { "ro": { "fields": { ... }, "probe": { ... } }, "rw": { "fields": { ... } } },
 *     "updatedAt": "<ISO>" } },
 *   "requests": { "<uuid>": { "kind": "...", "name": "...", "tier": "rw",
 *     "fields": { ... }, "status": "pending", ... } },
 *   "cases": { "<uuid>": { "title": "...", "symptoms": [...],
 *     "rootCause": "...", "fix": "...", "hitCount": 0, ... } } }
 * ```
 *
 * `requests` is the agent-registration approval queue (see server.ts
 * `/requests` routes); a decided request keeps its metadata but its `fields`
 * are wiped.
 *
 * `cases` is the troubleshooting knowledge base (see server.ts `/cases`
 * routes): distilled postmortems an agent records after an investigation
 * resolves, searchable by later sessions. Cases hold no secret material.
 *
 * The hub is dumb storage: file fields hold their *content* (inlined at
 * import time) and no kind-specific schema validation happens here.
 *
 * Mutations are also mirrored to an append-only audit log
 * (`<data-dir>/audit.log`, one JSON object per line) — never containing
 * field values.
 *
 * @module
 */

import { appendFile, chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decryptDoc, encryptDoc, loadMasterKey } from './crypto.js'

export type TierName = 'ro' | 'rw'

/** Profile name / kind charset; kinds additionally can never contain `/` (path segment). Shared by the HTTP surface and the offline importer. */
export const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/

export interface ProbeState {
  status: 'verified' | 'mismatch' | 'unverifiable'
  detail?: string
  probedAt: string
}

export interface EntryEnvelope {
  name?: string
  description?: string
  environment?: string
}

export interface TierData {
  fields: Record<string, unknown>
  probe?: ProbeState
}

export interface HubEntry {
  kind: string
  name: string
  envelope: EntryEnvelope
  tiers: { ro?: TierData; rw?: TierData }
  updatedAt: string
}

export type RequestStatus = 'pending' | 'approved' | 'rejected'

/**
 * A tier-registration request submitted by an agent, pending human approval.
 * `fields` holds the secret material (encrypted at rest with the rest of the
 * document) and is WIPED on decision — the approved copy lives on the entry.
 */
export interface RegistrationRequest {
  id: string
  kind: string
  name: string
  tier: TierName
  fields: Record<string, unknown>
  envelope: EntryEnvelope
  reason?: string
  status: RequestStatus
  createdAt: string
  decidedAt?: string
}

interface HubDoc {
  version: 1
  entries: Record<string, HubEntry>
  /** Absent in data files written before the approval flow existed. */
  requests?: Record<string, RegistrationRequest>
  /** Absent in data files written before the knowledge base existed. */
  cases?: Record<string, CaseRecord>
}

/** Hard caps on the knowledge base, enforced by the store (it owns the doc). */
export const MAX_CASES = 500

/**
 * A distilled troubleshooting postmortem. `hitCount` rises every time a
 * later session reports the case as useful, so the valuable cases float to
 * the top of the index and the rest sink.
 */
export interface CaseRecord {
  id: string
  title: string
  symptoms: string[]
  rootCause: string
  fix: string
  evidence?: string
  /** How the root cause was found — the discriminating steps/commands, for reuse in similar-but-not-identical situations. */
  methodology?: string
  /** Self-assessed diagnosis difficulty, 1 (obvious at a glance) to 5 (multi-day, cross-system). */
  difficulty?: number
  tags: string[]
  environment?: string
  hitCount: number
  createdAt: string
  updatedAt: string
}

/** Fields a client may write on a case; the server owns id/hitCount/timestamps. */
export type CaseInput = Partial<Omit<CaseRecord, 'id' | 'hitCount' | 'createdAt' | 'updatedAt'>>

export interface AuditRecord {
  ts: string
  role: 'admin' | 'read'
  action: 'resolve' | 'put' | 'delete' | 'request' | 'approve' | 'reject' | 'case-put' | 'case-hit' | 'case-delete'
  kind: string
  name: string
  /** Absent on `case-*` actions (cases have no tiers). */
  tier?: TierName
  /** Case title, recorded on `case-*` actions only. */
  title?: string
}

export interface HubStoreOptions {
  dataDir: string
  /** Defaults to `<dataDir>/hub.key`. */
  keyFile?: string
  /** Master key text (base64/hex); takes priority over the key file. */
  envKey?: string
}

export class HubStore {
  readonly dataDir: string
  readonly dataFile: string
  readonly auditFile: string
  private readonly keyFile: string
  private readonly envKey?: string
  private key!: Buffer
  private doc: HubDoc = { version: 1, entries: {} }

  constructor(opts: HubStoreOptions) {
    this.dataDir = opts.dataDir
    this.dataFile = join(opts.dataDir, 'hub-data.json.enc')
    this.auditFile = join(opts.dataDir, 'audit.log')
    this.keyFile = opts.keyFile ?? join(opts.dataDir, 'hub.key')
    this.envKey = opts.envKey
  }

  /** Resolve the master key and decrypt the data file (a missing file means a fresh hub). */
  async init(): Promise<void> {
    this.key = await loadMasterKey({ envKey: this.envKey, keyFile: this.keyFile })
    let blob: string
    try {
      blob = await readFile(this.dataFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    this.doc = JSON.parse(decryptDoc(blob, this.key)) as HubDoc
  }

  /** Encrypt the in-memory document and atomically replace the data file (mode 0600). */
  async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const blob = encryptDoc(JSON.stringify(this.doc), this.key)
    // Unique tmp name per save: concurrent saves must never share one file.
    const tmp = `${this.dataFile}.tmp-${randomUUID()}`
    // fsync the payload before the rename so a power cut cannot leave a
    // zero-length or stale-bytes data file behind the new name.
    const fh = await open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(blob)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, this.dataFile)
    await chmod(this.dataFile, 0o600)
    // fsync the directory so the rename itself is durable.
    const dh = await open(this.dataDir, 'r')
    try {
      await dh.sync()
    } finally {
      await dh.close()
    }
  }

  list(): HubEntry[] {
    return Object.values(this.doc.entries)
  }

  getEntry(kind: string, name: string): HubEntry | undefined {
    return this.doc.entries[`${kind}/${name}`]
  }

  /** Upsert one tier of an entry; `envelope` replaces the entry envelope wholesale when given. */
  putTier(kind: string, name: string, tier: TierName, data: { fields: Record<string, unknown>; envelope?: EntryEnvelope; probe?: ProbeState }): HubEntry {
    const key = `${kind}/${name}`
    const entry: HubEntry = this.doc.entries[key] ?? { kind, name, envelope: {}, tiers: {}, updatedAt: '' }
    if (data.envelope !== undefined) entry.envelope = data.envelope
    const tierData: TierData = { fields: data.fields }
    if (data.probe !== undefined) tierData.probe = data.probe
    entry.tiers[tier] = tierData
    entry.updatedAt = new Date().toISOString()
    this.doc.entries[key] = entry
    return entry
  }

  /** Delete one tier; removes the whole entry when its last tier goes. Returns false when absent. */
  deleteTier(kind: string, name: string, tier: TierName): boolean {
    const key = `${kind}/${name}`
    const entry = this.doc.entries[key]
    if (!entry || !entry.tiers[tier]) return false
    delete entry.tiers[tier]
    if (!entry.tiers.ro && !entry.tiers.rw) delete this.doc.entries[key]
    else entry.updatedAt = new Date().toISOString()
    return true
  }

  /** The requests map, created lazily (old data files predate the approval flow). */
  private requests(): Record<string, RegistrationRequest> {
    return (this.doc.requests ??= {})
  }

  /** Queue a tier-registration request; returns the generated id. */
  putRequest(data: { kind: string; name: string; tier: TierName; fields: Record<string, unknown>; envelope: EntryEnvelope; reason?: string }): RegistrationRequest {
    const request: RegistrationRequest = {
      id: randomUUID(),
      kind: data.kind,
      name: data.name,
      tier: data.tier,
      fields: data.fields,
      envelope: data.envelope,
      ...(data.reason !== undefined ? { reason: data.reason } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    this.requests()[request.id] = request
    return request
  }

  listRequests(status?: RequestStatus): RegistrationRequest[] {
    const all = Object.values(this.requests())
    return status === undefined ? all : all.filter((r) => r.status === status)
  }

  getRequest(id: string): RegistrationRequest | undefined {
    return this.requests()[id]
  }

  /**
   * Settle a pending request. On approval the tier is written through
   * `putTier`. Either way the request's `fields` are wiped — secret material
   * must not linger in a decided record. Returns null when absent or not
   * pending.
   */
  decideRequest(id: string, approved: boolean): RegistrationRequest | null {
    const request = this.requests()[id]
    if (!request || request.status !== 'pending') return null
    if (approved) {
      this.putTier(request.kind, request.name, request.tier, { fields: request.fields, envelope: request.envelope })
    }
    request.status = approved ? 'approved' : 'rejected'
    request.decidedAt = new Date().toISOString()
    request.fields = {}
    return request
  }

  /** The cases map, created lazily (old data files predate the knowledge base). */
  private cases(): Record<string, CaseRecord> {
    return (this.doc.cases ??= {})
  }

  /** Case index rows — metadata only, never the full text fields. */
  listCases(): Array<Pick<CaseRecord, 'id' | 'title' | 'symptoms' | 'tags' | 'hitCount' | 'updatedAt'>> {
    return Object.values(this.cases()).map((c) => ({
      id: c.id,
      title: c.title,
      symptoms: c.symptoms,
      tags: c.tags,
      hitCount: c.hitCount,
      updatedAt: c.updatedAt,
    }))
  }

  getCase(id: string): CaseRecord | undefined {
    return this.cases()[id]
  }

  /**
   * Create a case, or update one when `id` is given (only the provided
   * fields change; hitCount/createdAt survive). Returns null when updating
   * an absent id. Throws when the knowledge base is at MAX_CASES.
   */
  putCase(input: CaseInput, id?: string): CaseRecord | null {
    const now = new Date().toISOString()
    if (id !== undefined) {
      const existing = this.cases()[id]
      if (!existing) return null
      Object.assign(existing, input)
      existing.updatedAt = now
      return existing
    }
    if (Object.keys(this.cases()).length >= MAX_CASES) {
      throw new Error(`knowledge base is full (${MAX_CASES} cases); delete stale cases first`)
    }
    const record: CaseRecord = {
      id: randomUUID(),
      title: input.title ?? '',
      symptoms: input.symptoms ?? [],
      rootCause: input.rootCause ?? '',
      fix: input.fix ?? '',
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.methodology !== undefined ? { methodology: input.methodology } : {}),
      ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
      tags: input.tags ?? [],
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      hitCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.cases()[record.id] = record
    return record
  }

  /** Bump a case's hit count. Returns false when absent. */
  hitCase(id: string): boolean {
    const record = this.cases()[id]
    if (!record) return false
    record.hitCount += 1
    return true
  }

  /** Delete a case. Returns false when absent. */
  deleteCase(id: string): boolean {
    if (!this.cases()[id]) return false
    delete this.cases()[id]
    return true
  }

  /** Append one audit line for a case action (kind fixed to 'case', name = case id). */
  async auditCase(role: AuditRecord['role'], action: 'case-put' | 'case-hit' | 'case-delete', record: { id: string; title: string }): Promise<void> {
    await this.appendAudit({ ts: new Date().toISOString(), role, action, kind: 'case', name: record.id, title: record.title })
  }

  /** Append one audit line. Field values are never recorded. */
  async audit(role: AuditRecord['role'], action: AuditRecord['action'], kind: string, name: string, tier: TierName): Promise<void> {
    await this.appendAudit({ ts: new Date().toISOString(), role, action, kind, name, tier })
  }

  private async appendAudit(record: AuditRecord): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    // A crash mid-append can leave a torn tail line without a newline; a
    // naive append would fuse the next record onto it and lose both. Start
    // a fresh line when the file does not end with one.
    let prefix = ''
    try {
      const fh = await open(this.auditFile, 'r')
      try {
        const { size } = await fh.stat()
        if (size > 0) {
          const last = Buffer.alloc(1)
          await fh.read(last, 0, 1, size - 1)
          if (last[0] !== 0x0a) prefix = '\n'
        }
      } finally {
        await fh.close()
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await appendFile(this.auditFile, prefix + JSON.stringify(record) + '\n', { mode: 0o600 })
  }

  /** Read the most recent `limit` audit records, oldest first. */
  async readAudit(limit: number): Promise<AuditRecord[]> {
    let text: string
    try {
      text = await readFile(this.auditFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    // Tolerate a torn final line (crash mid-append): skip unparseable
    // records instead of poisoning every future read.
    const records = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditRecord]
        } catch {
          return []
        }
      })
    return records.slice(-limit)
  }
}
