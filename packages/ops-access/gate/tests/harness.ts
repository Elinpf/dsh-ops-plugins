/**
 * Test harness for ops-access-gate: mounts core (the real file-reading resolve)
 * AND the gate (the ledger + broker + request_access tool) against one mock
 * context, with a real tmp registry file and a real tmp audit log. Specs
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

/** A provider whose processed field betrays which tier a profile came from. */
export const testProvider: AccessProvider = {
  kind: 'test',
  schema: zod.object({ endpoint: zod.string() }),
}

/** An approval-required kind (mirrors ssh's posture: credential in the ro tier). */
export const sshProvider: AccessProvider = {
  kind: 'ssh',
  schema: zod.object({ host: zod.string() }),
}

export const REGISTRY = `\
version: 1
test:
  prod:
    environment: prod
    ro:
      endpoint: https://ro-prod.internal
    rw:
      endpoint: https://rw-prod.internal
`

export const SSH_REGISTRY = `\
ssh:
  box:
    ro:
      host: 10.0.0.1
`

export interface SetupOptions {
  config?: Partial<Config>
  /** Omit the web server to simulate a headless deployment (no approval channel). */
  headless?: boolean
  /** Mount the gate BEFORE core — exercises the deferred-inject mounting path. */
  gateFirst?: boolean
}

export function setup(opts: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-access-gate-'))
  const registryFile = join(dir, 'access.yaml')
  const auditFile = join(dir, 'audit.log')
  let opsAccess: OpsAccess | undefined
  let opsAccessGate: OpsAccessGate | undefined
  const listeners: Array<{ event: string, listener: (...args: any[]) => unknown, options?: unknown }> = []
  const routes: any[] = []
  const tools: any[] = []
  const commands: any[] = []
  // Deferred inject, mirroring cordis: an inject whose deps are not yet
  // provided pends and fires when they are. This is what makes gate-first
  // mounting work — the broker registration waits for core to provide
  // opsAccess instead of silently never happening.
  const services = new Map<string, any>()
  const pending: Array<{ deps: string[], cb: (c: any) => void }> = []
  const webServer = { register: (route: any) => { routes.push(route); return () => {} } }
  if (!opts.headless) services.set('webServer', webServer)
  services.set('commands', { register: (def: any) => { commands.push(def); return () => {} } })
  const injectionCtx: any = () => ({
    opsAccess: services.get('opsAccess'),
    webServer,
    commands: services.get('commands'),
    get: (key: string) => services.get(key),
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
    get: (key: string) => services.get(key) ?? (key === 'opsAccess' ? opsAccess : undefined),
    effect: (fn: () => () => void) => { fn() },
    tools: { register: (tool: any) => { tools.push(tool); return () => {} } },
  }
  const mountGate = () => gateApply(ctx, {
    approvalRequiredKinds: ['ssh'],
    defaultTtlMinutes: 30,
    maxTtlMinutes: 480,
    auditFile,
    grantTtlOptions: [5, 10, 30],
    pendingRequestTimeoutMinutes: 5,
    ...opts.config,
  })
  const mountCore = () => coreApply(ctx, { registryFile, credentialsDir: join(dir, 'credentials') })
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

  /** Find a captured route by path and drive its handler with a fake req/res. */
  async function callRoute(path: string, opts: { method?: string, query?: string, body?: unknown } = {}) {
    const route = routes.find((r) => r.path === path)
    if (!route) throw new Error('route not registered: ' + path + ' (have: ' + routes.map((r) => r.path).join(', ') + ')')
    const chunks: string[] = []
    const req: any = {
      method: opts.method ?? 'GET',
      url: 'http://localhost' + path + (opts.query ?? ''),
      on: (event: string, cb: (chunk?: string) => void) => {
        if (event === 'data' && opts.body !== undefined) cb(JSON.stringify(opts.body))
        if (event === 'end') cb()
      },
    }
    const res: any = {
      status: 0,
      writeHead(status: number) { this.status = status },
      end(text: string) { chunks.push(text) },
    }
    await route.handler(req, res)
    return { status: res.status as number, json: JSON.parse(chunks.join('')) }
  }

  return {
    opsAccess: opsAccess!,
    gate: opsAccessGate!,
    listeners,
    routes,
    tools,
    commands,
    callRoute,
    callRequestAccess,
    dir,
    registryFile,
    auditFile,
    writeRegistry: (text: string) => writeFileSync(registryFile, text),
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
