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

const USAGE = `dsh-ops-access-hub — standalone credential hub for the dsh ops suite

Usage:
  dsh-ops-access-hub serve [options]
  dsh-ops-access-hub import <access.yaml> (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
  dsh-ops-access-hub --help

serve options (flag / env / default):
  --port         ACCESS_HUB_PORT          3090
  --host         ACCESS_HUB_HOST          127.0.0.1
  --data-dir     ACCESS_HUB_DATA_DIR      ~/.dsh-ops-hub
  --key-file     ACCESS_HUB_KEY_FILE      <data-dir>/hub.key
  --admin-token  ACCESS_HUB_ADMIN_TOKEN   (generated + printed once when unset)
  --read-token   ACCESS_HUB_READ_TOKEN    (generated + printed once when unset)

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
  const hubUrl = flags.url
  const adminToken = flags['admin-token'] ?? process.env.ACCESS_HUB_ADMIN_TOKEN
  const dataDir = flags['data-dir'] ? expandHome(flags['data-dir']) : undefined
  if (!hubUrl && !dataDir) throw new Error('import: specify either --url <hubUrl> or --data-dir <dir>')
  if (hubUrl && dataDir) throw new Error('import: --url and --data-dir are mutually exclusive')
  if (hubUrl && !adminToken) throw new Error('import: --url mode requires --admin-token (or ACCESS_HUB_ADMIN_TOKEN)')

  const { entries, stats } = await importRegistry(expandHome(registryFile))
  if (hubUrl) {
    await pushToHub(hubUrl, adminToken as string, entries)
  } else {
    const keyFile = expandHome(
      pick(flags, 'key-file', process.env.ACCESS_HUB_KEY_FILE, join(dataDir as string, 'hub.key')),
    )
    const store = new HubStore({ dataDir: dataDir as string, keyFile, envKey: process.env.ACCESS_HUB_KEY })
    await store.init()
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
