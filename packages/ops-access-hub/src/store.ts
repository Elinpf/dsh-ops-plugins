/**
 * Encrypted document store for the hub.
 *
 * The whole dataset is a single JSON document (`<data-dir>/hub-data.json.enc`)
 * holding at most a few dozen entries, so it is decrypted into memory on
 * load and re-encrypted on every mutation; plaintext never touches the disk.
 * Writes are atomic: encrypt to a temp file in the same directory, then
 * rename over the target.
 *
 * Document shape:
 *
 * ```json
 * { "version": 1, "entries": { "k8s/prod": {
 *     "kind": "k8s", "name": "prod",
 *     "envelope": { "name": "...", "description": "...", "environment": "prod" },
 *     "tiers": { "ro": { "fields": { ... }, "probe": { ... } }, "rw": { "fields": { ... } } },
 *     "updatedAt": "<ISO>" } } }
 * ```
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

import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptDoc, encryptDoc, loadMasterKey } from './crypto.js'

export type TierName = 'ro' | 'rw'

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

interface HubDoc {
  version: 1
  entries: Record<string, HubEntry>
}

export interface AuditRecord {
  ts: string
  role: 'admin' | 'read'
  action: 'resolve' | 'put' | 'delete'
  kind: string
  name: string
  tier: TierName
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
    const tmp = `${this.dataFile}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, blob, { mode: 0o600 })
    await rename(tmp, this.dataFile)
    await chmod(this.dataFile, 0o600)
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

  /** Append one audit line. Field values are never recorded. */
  async audit(role: AuditRecord['role'], action: AuditRecord['action'], kind: string, name: string, tier: TierName): Promise<void> {
    const record: AuditRecord = { ts: new Date().toISOString(), role, action, kind, name, tier }
    await mkdir(this.dataDir, { recursive: true })
    await appendFile(this.auditFile, JSON.stringify(record) + '\n', { mode: 0o600 })
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
    const records = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AuditRecord)
    return records.slice(-limit)
  }
}
