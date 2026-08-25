/**
 * Test harness for ops-access-gate: mounts core (the real file-reading resolve)
 * AND the gate (the ledger + broker + request_access tool) against one mock
 * context, with real tmp ro/rw registry files and a real tmp audit log. Specs
 * drive resolve through ctx.opsAccess, drive the tool through the captured
 * registration, and inject approvals through the mock approval channel — the
 * externally observable seam.
 *
 * The broker is wired through core's real deferred registration: the gate's
 * apply calls registerAccessBroker → ctx.inject(['opsAccess'], cb), and this
 * harness's inject mirrors cordis's deferred semantics — an inject whose deps
 * are not yet provided pends and fires on provide, so mounting the gate before
 * core (opts.gateFirst) still lands the broker.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z as zod } from 'zod'
import { apply as coreApply } from '@deepseek-ai/dsh-ops-access'
import type { AccessProvider, OpsAccess } from '@deepseek-ai/dsh-ops-access'
import { apply as gateApply } from '../src/index.ts'
import type { Config, OpsAccessGate } from '../src/index.ts'

/** A provider whose processed field betrays which file a profile came from. */
export const testProvider: AccessProvider = {
  kind: 'test',
  schema: zod.object({ endpoint: zod.string() }),
}

/** An approval-required kind (mirrors ssh's posture: credential in the ro file). */
export const sshProvider: AccessProvider = {
  kind: 'ssh',
  schema: zod.object({ host: zod.string() }),
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

export const SSH_REGISTRY = `\
ssh:
  box:
    host: 10.0.0.1
`

export interface SetupOptions {
  config?: Partial<Config>
  /** Outcome the mock approval channel settles on; omit for "no channel". */
  approvalOutcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  /** Mount the gate BEFORE core — exercises the deferred-inject mounting path. */
  gateFirst?: boolean
}

export function setup(opts: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-access-gate-'))
  const roFile = join(dir, 'access.yaml')
  const rwFile = join(dir, 'access-rw.yaml')
  const auditFile = join(dir, 'audit.log')
  let opsAccess: OpsAccess | undefined
  let opsAccessGate: OpsAccessGate | undefined
  const listeners: Array<{ event: string, listener: (...args: any[]) => unknown, options?: unknown }> = []
  const routes: any[] = []
  const tools: any[] = []
  const approvalRequests: any[] = []
  const approval = opts.approvalOutcome === undefined
    ? undefined
    : {
        request: async (req: any) => {
          approvalRequests.push(req)
          return opts.approvalOutcome
        },
      }
  // Deferred inject, mirroring cordis: an inject whose deps are not yet
  // provided pends and fires when they are. This is what makes gate-first
  // mounting work — the broker registration waits for core to provide
  // opsAccess instead of silently never happening.
  const services = new Map<string, any>()
  const pending: Array<{ deps: string[], cb: (c: any) => void }> = []
  const webServer = { register: (route: any) => { routes.push(route); return () => {} } }
  services.set('webServer', webServer)
  const injectionCtx = () => ({
    opsAccess: services.get('opsAccess'),
    webServer,
    effect: (fn: () => () => void) => { fn() },
  })
  const flush = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].deps.every((d) => services.has(d))) {
        const { cb } = pending.splice(i, 1)[0]
        cb(injectionCtx())
      }
    }
  }
  const ctx: any = {
    provide: (key: string, value: any) => {
      services.set(key, value)
      if (key === 'opsAccess') opsAccess = value
      if (key === 'opsAccessGate') opsAccessGate = value
      flush()
    },
    on: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => {
      listeners.push({ event, listener, options })
      return () => {}
    },
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.every((d) => services.has(d))) cb(injectionCtx())
      else pending.push({ deps, cb })
    },
    get: (key: string) => {
      if (key === 'opsAccess') return opsAccess
      if (key === 'approval') return approval
      return undefined
    },
    effect: (fn: () => () => void) => { fn() },
    tools: { register: (tool: any) => { tools.push(tool); return () => {} } },
  }
  const mountGate = () => gateApply(ctx, {
    approvalRequiredKinds: ['ssh'],
    defaultTtlMinutes: 30,
    maxTtlMinutes: 480,
    auditFile,
    ...opts.config,
  })
  const mountCore = () => coreApply(ctx, { registryFile: roFile, rwRegistryFile: rwFile })
  if (opts.gateFirst) {
    mountGate()
    mountCore()
  } else {
    mountCore()
    mountGate()
  }
  opsAccess!.register(testProvider)
  opsAccess!.register(sshProvider)

  /** The registered request_access tool's execute, driven directly. */
  async function callRequestAccess(args: Record<string, unknown>, exec: Record<string, unknown> = {}) {
    const tool = tools.find((t) => t.name === 'request_access')
    if (!tool) throw new Error('request_access was not registered')
    return tool.execute(args, exec) as Promise<{ ok: boolean, message: string }>
  }

  return {
    opsAccess: opsAccess!,
    gate: opsAccessGate!,
    listeners,
    routes,
    tools,
    approvalRequests,
    callRequestAccess,
    dir,
    roFile,
    rwFile,
    auditFile,
    writeRo: (text: string) => writeFileSync(roFile, text),
    writeRw: (text: string) => writeFileSync(rwFile, text),
    readAudit: (): Array<Record<string, unknown>> => {
      let text: string
      try {
        text = readFileSync(auditFile, 'utf8')
      } catch {
        return [] // no audit line has ever been written
      }
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
  }
}
