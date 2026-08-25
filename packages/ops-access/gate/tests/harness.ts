/**
 * Test harness for ops-access-gate: mounts core (the real file-reading resolve)
 * AND the gate (the ledger + broker) against one mock context, with real tmp
 * ro/rw registry files. Specs drive resolve through ctx.opsAccess and inject
 * grants through ctx.opsAccessGate — the externally observable seam.
 *
 * The broker is wired through core's real deferred registration: the gate's
 * apply calls registerAccessBroker → ctx.inject(['opsAccess'], cb), and this
 * harness's inject hands cb the live opsAccess handle so the broker lands in
 * core for real.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z as zod } from 'zod'
import { apply as coreApply } from '@deepseek-ai/dsh-ops-access'
import type { AccessProvider, OpsAccess } from '@deepseek-ai/dsh-ops-access'
import { apply as gateApply } from '../src/index.ts'
import type { OpsAccessGate } from '../src/index.ts'

/** A provider whose processed field betrays which file a profile came from. */
export const testProvider: AccessProvider = {
  kind: 'test',
  schema: zod.object({ endpoint: zod.string() }),
}

export const RO_REGISTRY = `\
version: 1
test:
  prod:
    endpoint: https://ro-prod.internal
    environment: prod
`

export const RW_REGISTRY = `\
version: 1
test:
  prod:
    endpoint: https://rw-prod.internal
    environment: prod
`

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ops-access-gate-'))
  const roFile = join(dir, 'access.yaml')
  const rwFile = join(dir, 'access-rw.yaml')
  let opsAccess: OpsAccess | undefined
  let opsAccessGate: OpsAccessGate | undefined
  const listeners: Array<{ event: string, listener: (...args: any[]) => unknown, options?: unknown }> = []
  const routes: any[] = []
  const wctx = {
    effect: (fn: () => () => void) => { fn() },
    webServer: { register: (route: any) => { routes.push(route); return () => {} } },
  }
  const ctx: any = {
    provide: (key: string, value: any) => {
      if (key === 'opsAccess') opsAccess = value
      if (key === 'opsAccessGate') opsAccessGate = value
    },
    on: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => {
      listeners.push({ event, listener, options })
      return () => {}
    },
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.includes('webServer')) cb(wctx)
      // The gate's registerAccessBroker defers onto opsAccess; hand it the
      // live handle so the broker really registers into core.
      if (deps.includes('opsAccess') && opsAccess) {
        cb({ opsAccess, effect: (fn: () => () => void) => { fn() } })
      }
    },
  }
  coreApply(ctx, { registryFile: roFile, rwRegistryFile: rwFile })
  gateApply(ctx, {})
  opsAccess!.register(testProvider)
  return {
    opsAccess: opsAccess!,
    gate: opsAccessGate!,
    listeners,
    routes,
    dir,
    roFile,
    rwFile,
    writeRo: (text: string) => writeFileSync(roFile, text),
    writeRw: (text: string) => writeFileSync(rwFile, text),
  }
}
