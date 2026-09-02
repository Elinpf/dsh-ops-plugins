#!/usr/bin/env node
// @elinpf/dsh-ops — deployment helper for the ops plugin suite.
//
// Usage:
//   dsh-ops preset install [--agents-home <dir>]   copy the ops agent preset
//   dsh-ops preset remove  [--agents-home <dir>]   delete it
//
// The harness discovers agent presets only as directories under
// <agents-home>/.agent-presets/ — there is no package-native preset channel —
// so this helper materializes the preset shipped in this package. Discovery
// re-reads the roots on every call; a restart of the profile is still needed
// for the web surface.

import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const presetDir = fileURLToPath(new URL('../presets/ops', import.meta.url))

function parseArgs(argv) {
  const [command, subcommand] = argv
  const homeFlag = argv.indexOf('--agents-home')
  const agentsHome = homeFlag !== -1 ? resolve(argv[homeFlag + 1]) : process.env.DSH_AGENTS_HOME ?? resolve(process.env.HOME ?? '.', '.agents')
  return { command, subcommand, agentsHome }
}

async function main() {
  const { command, subcommand, agentsHome } = parseArgs(process.argv.slice(2))
  if (command !== 'preset') {
    console.error('usage: dsh-ops preset install|remove [--agents-home <dir>]')
    process.exit(2)
  }
  const target = join(agentsHome, '.agent-presets', 'ops')
  if (subcommand === 'install') {
    await rm(target, { recursive: true, force: true })
    await mkdir(join(agentsHome, '.agent-presets'), { recursive: true })
    await cp(presetDir, target, { recursive: true })
    console.log(`dsh-ops: installed the ops agent preset at ${target}`)
    console.log('dsh-ops: restart the profile for the change to take effect')
  } else if (subcommand === 'remove') {
    const present = await stat(target).then(() => true, () => false)
    if (!present) {
      console.error(`dsh-ops: no preset at ${target}`)
      process.exit(1)
    }
    await rm(target, { recursive: true })
    console.log(`dsh-ops: removed ${target}`)
    console.log('dsh-ops: restart the profile for the change to take effect')
  } else {
    console.error('usage: dsh-ops preset install|remove [--agents-home <dir>]')
    process.exit(2)
  }
}

main().catch((error) => {
  console.error(`dsh-ops: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
