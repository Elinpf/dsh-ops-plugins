/**
 * Ops access hub — a standalone, centrally deployable credential management
 * service for the dsh ops suite. **Not a dsh plugin**: no cordis patch, no
 * preset row. The access side pulls secret content from it over HTTP.
 *
 * - encrypted-at-rest single-document store (AES-256-GCM), see `./store.js`;
 * - token-authenticated REST API + minimal web UI, see `./server.js`;
 * - YAML registry importer, see `./import.js`;
 * - `dsh-ops-access-hub` bin (`serve` / `import`), see `./cli.js`.
 *
 * @module @elinpf/dsh-ops-access-hub
 */

export { MASTER_KEY_BYTES, generateMasterKey, parseMasterKey, loadMasterKey, encryptDoc, decryptDoc } from './crypto.js'
export { HubStore, MAX_CASES } from './store.js'
export type { TierName, ProbeState, EntryEnvelope, TierData, HubEntry, AuditRecord, HubStoreOptions, CaseRecord, CaseInput } from './store.js'
export { createHubServer, NAME_PATTERN } from './server.js'
export type { HubServerOptions } from './server.js'
export { importRegistry, pushToHub, applyToStore } from './import.js'
export type { ImportedEntry, ImportStats, ImportResult } from './import.js'
export { WEB_UI_HTML } from './web.js'
