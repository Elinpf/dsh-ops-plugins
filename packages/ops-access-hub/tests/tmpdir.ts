/**
 * Shared scratch-dir helper for hub specs: mkdtemp under the OS temp dir,
 * tracked so the whole batch is removed when the test process exits —
 * without this every test run litters /tmp (2026-09-11).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const createdDirs: string[] = []
const sweep = (): void => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true })
}
// Registered at module scope: hooks must bind during collection, not inside a
// test body. afterAll is the primary sweep (vitest kills workers with no
// 'exit' event, so a plain process hook never fires); the exit hook is a
// best-effort fallback for non-vitest use.
afterAll(sweep)
process.once('exit', sweep)

export function mktmpdir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}
