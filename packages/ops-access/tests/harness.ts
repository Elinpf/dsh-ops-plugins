/**
 * Test harness for ops-access: mounts the plugin against a minimal mock
 * context (capturing the provided opsAccess handle) and gives specs a real
 * tmp-dir registry file to drive the real file-reading code path.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import type { OpsAccess } from '../src/index.ts'

export function setup(opts: { registryFile?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-access-'))
  const registryFile = opts.registryFile ?? join(dir, 'access.yaml')
  let handle: OpsAccess | undefined
  const ctx: any = {
    provide: (key: string, value: any) => { if (key === 'opsAccess') handle = value },
  }
  apply(ctx, { registryFile })
  return {
    handle: handle!,
    dir,
    registryFile,
    write: (text: string) => writeFileSync(registryFile, text),
  }
}
