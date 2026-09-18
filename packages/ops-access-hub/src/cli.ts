#!/usr/bin/env node
/**
 * `dsh-ops-access-hub` CLI. Hand-rolled minimal argv parsing — no commander
 * & co. by design (dependency floor: `yaml` only).
 *
 * Commands:
 *
 * - `serve` — run the hub HTTP service.
 * - `import <access.yaml>` — convert an ops-access YAML registry and push it
 *   into a running hub (`--url` + `--admin-token`) or straight into a data
 *   directory (`--data-dir`, needs the master key).
 * - `token create|list|update|revoke` — issue, list, edit and revoke named
 *   tokens (ADR-0009 / ADR-0010), against a running hub (`--url` +
 *   `--admin-token`) or directly in a data directory (`--data-dir`).
 * - `--help` — usage.
 *
 * @module
 */

import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { join } from 'node:path'
import { HubStore } from './store.js'
import { createHubServer } from './server.js'
import { applyToStore, importRegistry, pushToHub } from './import.js'
import {
  generateToken,
  hashToken,
  parseExpiresAt,
  parseExpiresAtPatch,
  parseTokenName,
  parseTokenRole,
  toTokenView,
  tokenPrefix,
  tokenStatus,
} from './tokens.js'
import type { TokenChange, TokenView } from './tokens.js'

const USAGE = `dsh-ops-access-hub — standalone credential hub for the dsh ops suite

Usage:
  dsh-ops-access-hub serve [options]
  dsh-ops-access-hub import <access.yaml> (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
  dsh-ops-access-hub token create --name <name> --role <admin|read> [--expires-at <ISO>] (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
  dsh-ops-access-hub token list (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
  dsh-ops-access-hub token update --id <id> [--name <name>] [--role <admin|read>] [--expires-at <ISO> | --clear-expires] (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
  dsh-ops-access-hub token revoke --id <id> (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
  dsh-ops-access-hub --help

serve options (flag / env / default):
  --port         ACCESS_HUB_PORT          3090
  --host         ACCESS_HUB_HOST          127.0.0.1
  --data-dir     ACCESS_HUB_DATA_DIR      ~/.dsh-ops-hub
  --key-file     ACCESS_HUB_KEY_FILE      <data-dir>/hub.key
  --admin-token  ACCESS_HUB_ADMIN_TOKEN   (generated + printed once when unset)
  --read-token   ACCESS_HUB_READ_TOKEN    (generated + printed once when unset)

Named tokens (ADR-0009): issue one per holder with 'token create' and hand the
printed value over out of band — it is shown once and stored only as a digest.
--admin-token is the issuing credential (the static bootstrap token).
'token update' edits a live record in place (label / role / expiry) — the
secret itself never changes, so the holder keeps working without re-issuing
(pass --clear-expires to drop an expiry). 'token list' marks each record
active / expiring / EXPIRED / REVOKED.
The static admin/read tokens stay valid as break-glass credentials.

Master key: env ACCESS_HUB_KEY (base64/hex) wins; otherwise the key file is
used and generated (0600) on first start.
`

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string>
}

/** Minimal parser: `--flag value` pairs; everything else is positional. */
function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positional: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) out.flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[arg.slice(2)] = argv[++i]
      else out.flags[arg.slice(2)] = 'true'
    } else {
      out.positional.push(arg)
    }
  }
  return out
}

/** Expand a leading `~` to $HOME. */
function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? join(os.homedir(), p.slice(2)) : p
}

function pick(flags: Record<string, string>, flag: string, env: string | undefined, fallback: string): string {
  return flags[flag] ?? env ?? fallback
}

interface Target {
  hubUrl?: string
  adminToken?: string
  dataDir?: string
}

/**
 * Resolve the shared `--url <hubUrl> --admin-token <t>` vs `--data-dir <dir>`
 * target. The two are mutually exclusive; the HTTP form needs the admin token.
 * Errors carry the caller's command name as prefix.
 */
function resolveTarget(flags: Record<string, string>, command: string): Target {
  const hubUrl = flags.url
  const dataDir = flags['data-dir'] ? expandHome(flags['data-dir']) : undefined
  const adminToken = flags['admin-token'] ?? process.env.ACCESS_HUB_ADMIN_TOKEN
  if (!hubUrl && !dataDir) throw new Error(`${command}: specify either --url <hubUrl> or --data-dir <dir>`)
  if (hubUrl && dataDir) throw new Error(`${command}: --url and --data-dir are mutually exclusive`)
  if (hubUrl && !adminToken) throw new Error(`${command}: --url mode requires --admin-token (or ACCESS_HUB_ADMIN_TOKEN)`)
  return { hubUrl, adminToken, dataDir }
}

/** Open the encrypted store behind a `--data-dir` target. */
async function openStore(flags: Record<string, string>, dataDir: string): Promise<HubStore> {
  const keyFile = expandHome(pick(flags, 'key-file', process.env.ACCESS_HUB_KEY_FILE, join(dataDir, 'hub.key')))
  const store = new HubStore({ dataDir, keyFile, envKey: process.env.ACCESS_HUB_KEY })
  await store.init()
  return store
}

/**
 * One HTTP call against a running hub with the admin token. Errors never
 * embed the token, and a non-2xx response surfaces the hub's own `error`.
 */
async function hubRequest(hubUrl: string, adminToken: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`${hubUrl.replace(/\/$/, '')}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : text.slice(0, 200)
    throw new Error(`hub returned ${res.status}: ${detail}`)
  }
  return body
}

/** Whole days until an ISO expiry, rounded up so a live token never reads "0d left". */
function daysLeft(expiresAt: string, now: Date): number {
  return Math.ceil((Date.parse(expiresAt) - now.getTime()) / 86_400_000)
}

/** One roster line for `token list`; the state column mirrors the web UI's badges (ADR-0010). */
function formatToken(t: TokenView, now = new Date()): string {
  const status = tokenStatus(t, now)
  let state: string
  if (status === 'revoked') state = `REVOKED ${t.revokedAt}`
  else if (status === 'expired') state = `EXPIRED ${t.expiresAt}`
  else if (status === 'expiring') state = `expiring ${t.expiresAt} (${daysLeft(t.expiresAt as string, now)}d left)`
  else state = 'active'
  return `${t.id}  ${t.role.padEnd(5)}  ${t.prefix}...  ${t.name}  (created ${t.createdAt} by ${t.createdBy})  ${state}`
}

/** Build the `token update` patch from CLI flags; throws when there is nothing to change. */
function patchFromFlags(flags: Record<string, string>): { name?: string; role?: 'admin' | 'read'; expiresAt?: string | null } {
  try {
    if (flags['clear-expires'] === 'true' && flags['expires-at'] !== undefined) {
      throw new Error('--expires-at and --clear-expires are mutually exclusive')
    }
    const patch: { name?: string; role?: 'admin' | 'read'; expiresAt?: string | null } = {}
    if (flags.name !== undefined) patch.name = parseTokenName(flags.name)
    if (flags.role !== undefined) patch.role = parseTokenRole(flags.role)
    if (flags['clear-expires'] === 'true') patch.expiresAt = null
    else if (flags['expires-at'] !== undefined) patch.expiresAt = parseExpiresAtPatch(flags['expires-at']) ?? null
    if (patch.name === undefined && patch.role === undefined && patch.expiresAt === undefined) {
      throw new Error('nothing to change (use --name, --role, --expires-at or --clear-expires)')
    }
    return patch
  } catch (err) {
    throw new Error(`token update: ${(err as Error).message}`)
  }
}

/** Edit one token in an offline store (the caller saves when something changed). */
function updateTokenInStore(store: HubStore, id: string, patch: { name?: string; role?: 'admin' | 'read'; expiresAt?: string | null }): TokenChange[] {
  let updated
  try {
    updated = store.updateToken(id, patch)
  } catch (err) {
    throw new Error(`token update: ${(err as Error).message}`)
  }
  if (!updated) throw new Error(`token update: token ${id} not found`)
  return updated.changes
}

/** `token create|list|update|revoke` — issue and manage named tokens (ADR-0009/0010). */
async function tokenCmd(args: ParsedArgs): Promise<void> {
  const { positional, flags } = args
  const action = positional[1]
  if (action !== 'create' && action !== 'list' && action !== 'update' && action !== 'revoke') {
    throw new Error('token: expected one of create | list | update | revoke')
  }
  const { hubUrl, adminToken, dataDir } = resolveTarget(flags, `token ${action}`)
  const store = dataDir === undefined ? undefined : await openStore(flags, dataDir)

  if (action === 'list') {
    const tokens = store ? store.listTokens().map(toTokenView) : ((await hubRequest(hubUrl!, adminToken!, '/tokens')) as TokenView[])
    if (tokens.length === 0) console.log('no named tokens issued')
    else for (const t of tokens) console.log(formatToken(t))
    return
  }

  if (action === 'create') {
    const name = parseTokenName(flags.name ?? '')
    const role = parseTokenRole(flags.role ?? '')
    const expiresAt = parseExpiresAt(flags['expires-at'])
    const entity = store
      ? createTokenInStore(store, { name, role, expiresAt })
      : ((await hubRequest(hubUrl!, adminToken!, '/tokens', {
          method: 'POST',
          body: { name, role, ...(expiresAt !== undefined ? { expiresAt } : {}) },
        })) as { id: string; token: string })
    if (store) await store.save()
    console.log(`issued ${role} token '${name}' (id ${entity.id}) — hand it over out of band; it will not be shown again:`)
    console.log(`  ${entity.token}`)
    return
  }

  const id = flags.id
  if (!id) throw new Error(`token ${action}: missing --id <id>`)

  if (action === 'update') {
    const patch = patchFromFlags(flags)
    const changes = store
      ? updateTokenInStore(store, id, patch)
      : ((await hubRequest(hubUrl!, adminToken!, `/tokens/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })) as { changes: TokenChange[] }).changes
    // A no-op patch must not rewrite (and re-encrypt) the whole document.
    if (store && changes.length > 0) await store.save()
    console.log(changes.length === 0 ? `token ${id}: already up to date` : `updated token ${id}: ${changes.join(', ')}`)
    return
  }

  if (store) {
    const token = store.getToken(id)
    if (!token) throw new Error(`token revoke: token ${id} not found`)
    if (!store.revokeToken(id)) throw new Error(`token revoke: token ${id} is already revoked`)
    await store.save()
  } else {
    await hubRequest(hubUrl!, adminToken!, `/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  console.log(`revoked token ${id}`)
}

/** Mint + record one token in an offline store (the caller saves). */
function createTokenInStore(store: HubStore, input: { name: string; role: 'admin' | 'read'; expiresAt?: string }): { id: string; token: string } {
  if (store.findTokenByName(input.name)) throw new Error(`token create: name '${input.name}' is already in use`)
  const token = generateToken()
  const issued = store.putToken({
    name: input.name,
    role: input.role,
    hash: hashToken(token),
    prefix: tokenPrefix(token),
    createdBy: 'cli',
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  })
  return { id: issued.id, token }
}

async function serve(args: ParsedArgs): Promise<void> {
  const { flags } = args
  const port = Number.parseInt(pick(flags, 'port', process.env.ACCESS_HUB_PORT, '3090'), 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error(`invalid port`)
  const host = pick(flags, 'host', process.env.ACCESS_HUB_HOST, '127.0.0.1')
  const dataDir = expandHome(pick(flags, 'data-dir', process.env.ACCESS_HUB_DATA_DIR, '~/.dsh-ops-hub'))
  const keyFile = expandHome(pick(flags, 'key-file', process.env.ACCESS_HUB_KEY_FILE, join(dataDir, 'hub.key')))

  // Any token not injected via flag/env is generated randomly and printed
  // exactly once — there is no recovery path other than reconfiguring.
  let adminToken = flags['admin-token'] ?? process.env.ACCESS_HUB_ADMIN_TOKEN
  let readToken = flags['read-token'] ?? process.env.ACCESS_HUB_READ_TOKEN
  if (!adminToken) {
    adminToken = randomBytes(24).toString('base64url')
    console.log(`generated admin token (save it now — it will not be shown again):\n  ${adminToken}`)
  }
  if (!readToken) {
    do {
      readToken = randomBytes(24).toString('base64url')
    } while (readToken === adminToken)
    console.log(`generated read token (save it now — it will not be shown again):\n  ${readToken}`)
  }

  const store = new HubStore({ dataDir, keyFile, envKey: process.env.ACCESS_HUB_KEY })
  await store.init()
  const server = createHubServer({ store, adminToken, readToken })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => resolveListen())
  })
  console.log(`dsh-ops-access-hub listening on http://${host}:${port} (data dir: ${dataDir})`)
}

async function importCmd(args: ParsedArgs): Promise<void> {
  const { positional, flags } = args
  const registryFile = positional[1]
  if (!registryFile) throw new Error('import: missing <access.yaml> argument')
  const { hubUrl, adminToken, dataDir } = resolveTarget(flags, 'import')

  const { entries, stats } = await importRegistry(expandHome(registryFile))
  if (hubUrl) {
    await pushToHub(hubUrl, adminToken as string, entries)
  } else {
    const store = await openStore(flags, dataDir as string)
    applyToStore(store, entries)
    await store.save()
  }
  console.log(`imported ${stats.entries} entries, ${stats.tiers} tiers, ${stats.fileFields} file fields inlined`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.positional[0]
  if (command === 'serve') return serve(args)
  if (command === 'import') return importCmd(args)
  if (command === 'token') return tokenCmd(args)
  if (command === 'help' || args.flags.help === 'true' || args.flags.h === 'true' || command === undefined) {
    console.log(USAGE)
    return
  }
  console.error(`unknown command: ${command}\n\n${USAGE}`)
  process.exitCode = 1
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exitCode = 1
})
