/**
 * Type definitions for the ops-access capability seam.
 *
 * Types only — every runtime value (the `Config` schema, `expandHome`,
 * `registerAccessProvider`/`registerAccessBroker`, the plugin itself) lives
 * in index.ts.
 *
 * @module @elinpf/dsh-ops-access/types
 */

import type { ZodType } from 'zod'

// ── Config ───────────────────────────────────────────────────────────────────

// The Config interface lives in index.ts next to its schemastery schema const
// (declaration merging); re-exported here so `./types` carries the full set.
export type { Config } from './index.js'

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
   * nothing to accept. May be ASYNC — a provider may run a real local
   * parser (ssh passes the paste through ssh-keygen -y, the same parser ssh
   * runs at connection time). Receives the content AFTER provider-declared
   * normalization (normalizeTrailingNewline), i.e. exactly the bytes that
   * will land on disk. Keep it structural — format and shape only (a ceph
   * keyring has an indented, base64-decodable key line; a kubeconfig parses
   * as YAML with clusters/contexts/users), never connectivity or value
   * judgments. Catching paste corruption here beats a cryptic CLI parse
   * error at use time.
   */
  validateContent?: (field: string, content: string) => string | null | undefined | Promise<string | null | undefined>
  /**
   * When true, file-field content is normalized to end with exactly one
   * trailing newline BEFORE validation and write. PEM/armored formats
   * require the END line newline-terminated, and pastes / model transcripts
   * routinely drop that last byte (2026-08-27: a registered ssh key failed
   * in libcrypto at first use over exactly one missing newline).
   */
  normalizeTrailingNewline?: boolean
  /**
   * Capability probe (ticket 10): verify the credential's REAL
   * permissions against the claimed tier. Core runs it at save time,
   * after validation (credential files are on disk by then), and stores
   * the result as a `probe` key beside the tier in the registry —
   * surfaced by listAll / list_access / the admin UI. Receives the
   * schema-validated, provider-processed fields. A probe must be
   * READ-ONLY against the infrastructure (k8s runs a can-i matrix;
   * ceph re-reads `auth get` caps). Providers that cannot probe (ssh —
   * there is no read-only shell to test) omit the hook; their tiers
   * stay unprobed. Probe failures degrade to 'unverifiable' — they
   * never reject the write.
   */
  probe?: (fields: Record<string, unknown>, tier: 'ro' | 'rw') => Promise<{ status: ProbeState['status'], detail?: string }>
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

/**
 * Capability-probe outcome for one tier (ticket 10): whether the stored
 * credential's REAL permissions match its claimed tier, measured at save
 * time. 'verified' = claims match reality; 'mismatch' = reality
 * contradicts the tier (an admin credential sitting in the ro slot is
 * the classic case); 'unverifiable' = the probe could not run (binary
 * missing, cluster unreachable) — never a write rejection.
 */
export interface ProbeState {
  status: 'verified' | 'mismatch' | 'unverifiable'
  detail?: string
  /** ISO timestamp of the probe run. */
  probedAt: string
}

/** Validation status of one entry in one tier — `error` carries the zod reason, never field values. */
export interface AdminTierStatus {
  ok: boolean
  error?: string
  /** Capability-probe outcome recorded at save time, when the provider probes. */
  probe?: ProbeState
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
  canResolve(kind: string, name: string, tier: 'ro' | 'rw'): Promise<AdminTierStatus>
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
