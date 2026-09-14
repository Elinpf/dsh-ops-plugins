#!/usr/bin/env node
/**
 * Pack-coverage guard: for every publishable package, verify that each
 * built file under lib/ actually lands in the npm tarball. The `files`
 * whitelist in package.json is easy to forget when a source module is
 * added (0.2.0 shipped @elinpf/dsh-ops-access without lib/backend.js /
 * lib/hub-backend.js and ops-access-ui without lib/candidates.js — the
 * preset failed to mount and the @ dialog never loaded on npm installs).
 *
 * Runs `npm pack --dry-run --json` per package (no publish side effects)
 * and diffs the packed file list against the on-disk lib tree.
 * Requires a prior `pnpm -r run build`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const packagesDir = join(root, 'packages')

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

function* packageDirs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (!statSync(p).isDirectory()) continue
    if (existsSync(join(p, 'package.json'))) yield p
    else yield* packageDirs(p) // one nesting level (packages/ops-access/core)
  }
}

let failed = false
for (const dir of packageDirs(packagesDir)) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (manifest.private === true) continue
  const libDir = join(dir, 'lib')
  if (!existsSync(libDir)) continue
  const expected = [...walk(libDir)].map((f) => relative(dir, f)).filter((f) => !f.endsWith('.map')) // sourcemaps are optional payload, not runtime code
  if (expected.length === 0) continue
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  // prepack scripts (e.g. the client-bundle build) print to stdout ahead of
  // the JSON payload — slice from the first JSON opener.
  const jsonStart = out.search(/[[{]/)
  const parsed = JSON.parse(out.slice(jsonStart))
  // npm ≤10 returns an array; pnpm's npm shim returns an object keyed by name.
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  const packed = new Set(report.files.map((f) => f.path))
  const missing = expected.filter((f) => !packed.has(f))
  if (missing.length > 0) {
    failed = true
    console.error(`✗ ${manifest.name}: ${missing.length} built file(s) missing from the tarball:`)
    for (const f of missing) console.error(`    ${f}`)
    console.error(`  fix the "files" list in ${relative(root, dir)}/package.json`)
  } else {
    console.log(`✓ ${manifest.name} (${expected.length} lib files covered)`)
  }
}
if (failed) process.exit(1)
