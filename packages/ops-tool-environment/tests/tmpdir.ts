/**
 * Shared scratch-dir helper: mkdtemp under the OS temp dir, tracked so the
 * whole batch is removed in afterAll — without this every test run litters
 * /tmp (2026-09-11). afterAll is the primary sweep because vitest kills
 * workers with no 'exit' event; the exit hook is a non-vitest fallback.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const createdDirs: string[] = []
const sweep = (): void => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true })
}
afterAll(sweep)
process.once('exit', sweep)

export function mktmpdir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}
