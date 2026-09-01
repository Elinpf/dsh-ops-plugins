/**
 * Test harness for ops-access: mounts the plugin against a minimal mock
 * context (capturing the provided opsAccess handle) and gives specs a real
 * tmp-dir registry file to drive the real file-reading code path.
 *
 * The core now owns a SINGLE registry file (tier sub-objects live under each
 * entry's `ro:`/`rw:` keys), so the harness exposes only `registryFile`.
 * `writeRw` is a merge helper: it parses a new-format tier-doc and shallow-
 * merges each entry into the existing single file, so specs can compose an
 * "ro base + rw overlay" against one file.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { apply } from '../src/index.ts'
import type { OpsAccess } from '../src/index.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function setup(opts: { registryFile?: string, credentialsDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-access-'))
  const registryFile = opts.registryFile ?? join(dir, 'access.yaml')
  const credentialsDir = opts.credentialsDir ?? join(dir, 'credentials')
  let handle: OpsAccess | undefined
  const listeners: Array<{ event: string, listener: (...args: any[]) => unknown, options?: unknown }> = []
  const routes: any[] = []
  const tools: any[] = []
  // Effect disposers collected for HMR-unload assertions — mirrors cordis,
  // where ctx.effect/provide/on are all fiber-scoped and run their cleanup
  // when the fiber is disposed.
  const effectCleanups: Array<() => void> = []
  const collectEffect = (fn: () => (() => void) | void): void => {
    const dispose = fn()
    if (typeof dispose === 'function') effectCleanups.push(dispose)
  }
  // Deferred inject, mirroring cordis: an inject whose deps are not yet
  // provided pends and fires when they are — NOT silently dropped. This is
  // what registerAccessProvider's deferred-mount discipline is FOR; an
  // order-dependent mock would never exercise it.
  const services = new Map<string, any>()
  const pending: Array<{ deps: string[], cb: (c: any) => void }> = []
  const webServer = {
    register: (route: any) => {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }
  services.set('webServer', webServer)
  const injectionCtx = () => ({
    opsAccess: services.get('opsAccess'),
    webServer,
    effect: collectEffect,
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
      if (key === 'opsAccess') handle = value
      flush()
      // cordis wraps ctx.provide in fiber.effect — the service unregisters
      // when the fiber is disposed.
      effectCleanups.push(() => { services.delete(key) })
    },
    on: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => {
      const entry = { event, listener, options }
      listeners.push(entry)
      // cordis's ctx.on is itself fiber-scoped (fiber.effect), so the plugin
      // dropping the returned disposer is NOT a leak — mirror that here.
      const dispose = () => {
        const i = listeners.indexOf(entry)
        if (i >= 0) listeners.splice(i, 1)
      }
      effectCleanups.push(dispose)
      return dispose
    },
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.every((d) => services.has(d))) cb(injectionCtx())
      else pending.push({ deps, cb })
    },
    effect: collectEffect,
    tools: {
      register: (tool: any) => {
        tools.push(tool)
        return () => {
          const i = tools.indexOf(tool)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
  }
  apply(ctx, { registryFile, credentialsDir })
  /** Minimal mock response that captures status + JSON body. */
  const mockResponse = (): { writeHead: (s: number) => void, end: (text: string) => void, status: () => number, body: () => any } => {
    let status = 0
    let body: any = null
    return {
      writeHead: (s: number) => { status = s },
      end: (text: string) => { body = JSON.parse(text) },
      status: () => status,
      body: () => body,
    }
  }
  /** Drive a route by path, returning { status, body } from the mock response. */
  async function driveRoute(path: string, req: any = {}): Promise<{ status: number, body: any }> {
    const route = routes.find((r) => r.path === path)
    if (!route) return { status: 404, body: null }
    const res = mockResponse()
    await route.handler(req, res)
    return { status: res.status(), body: res.body() }
  }
  /** The registered register_access tool's execute, driven directly. */
  async function callRegisterAccess(args: Record<string, unknown>) {
    const tool = tools.find((t) => t.name === 'register_access')
    if (!tool) throw new Error('register_access was not registered')
    return tool.execute(args, {}) as Promise<{ ok: boolean, message: string }>
  }
  return {
    handle: handle!,
    /** The mock plugin context — HMR tests drive registerAccessProvider/Broker through it. */
    ctx,
    listeners,
    routes,
    tools,
    effectCleanups,
    /** Whether a service is still provided (post-disposal assertions). */
    hasService: (key: string) => services.has(key),
    callRegisterAccess,
    credentialsDir,
    /** Drive the mention-candidate route; parses the JSON body. */
    async listRoute(query = ''): Promise<{ status: number, body: any }> {
      return driveRoute('/ops-access/list', { url: `/ops-access/list?query=${encodeURIComponent(query)}` })
    },
    /** Drive the admin list route. */
    async adminListRoute(): Promise<{ status: number, body: any }> {
      return driveRoute('/ops-access/admin/list')
    },
    /** Drive the admin kinds route. */
    async adminKindsRoute(): Promise<{ status: number, body: any }> {
      return driveRoute('/ops-access/admin/kinds')
    },
    /** Drive the admin entry route with a POST body or DELETE query params. */
    async adminEntryRoute(opts: { method: 'POST' | 'DELETE', body?: string, query?: string }): Promise<{ status: number, body: any }> {
      const req: any = { method: opts.method }
      if (opts.method === 'POST') {
        const bodyText = opts.body ?? ''
        req.on = (event: string, cb: (chunk?: any) => void) => {
          if (event === 'data') cb(bodyText)
          if (event === 'end') cb()
        }
      } else {
        req.url = `/ops-access/admin/entry${opts.query ?? ''}`
      }
      return driveRoute('/ops-access/admin/entry', req)
    },
    dir,
    registryFile,
    write: (text: string) => writeFileSync(registryFile, text),
    /**
     * Merge a new-format tier-doc into the single registry file. Each entry in
     * the input (envelope fields at entry level, provider fields under `rw:`)
     * is shallow-merged into the matching entry of the existing file, so
     * `ro:` content and sibling entries are preserved. The file is created
     * when it does not yet exist.
     */
    writeRw: (text: string) => {
      const doc = parseYaml(text)
      let existing: Record<string, unknown> = {}
      try {
        const raw = readFileSync(registryFile, 'utf8')
        const parsed = parseYaml(raw)
        if (isPlainObject(parsed)) existing = parsed
      } catch { /* missing or unparseable → start fresh */ }
      if (isPlainObject(doc)) {
        for (const [kind, section] of Object.entries(doc)) {
          if (kind === 'version' || !isPlainObject(section)) continue
          if (!isPlainObject(existing[kind])) existing[kind] = {}
          const existingSection = existing[kind] as Record<string, unknown>
          for (const [name, entry] of Object.entries(section)) {
            if (!isPlainObject(entry)) continue
            if (!isPlainObject(existingSection[name])) existingSection[name] = {}
            Object.assign(existingSection[name] as Record<string, unknown>, entry)
          }
        }
      }
      existing.version = 1
      writeFileSync(registryFile, stringifyYaml(existing))
    },
  }
}
