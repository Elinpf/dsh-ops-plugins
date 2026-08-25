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

export function setup(opts: { registryFile?: string, rwRegistryFile?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-access-'))
  const registryFile = opts.registryFile ?? join(dir, 'access.yaml')
  const rwRegistryFile = opts.rwRegistryFile ?? join(dir, 'access-rw.yaml')
  let handle: OpsAccess | undefined
  const listeners: Array<{ event: string, listener: (...args: any[]) => unknown, options?: unknown }> = []
  const routes: any[] = []
  // Deferred inject, mirroring cordis: an inject whose deps are not yet
  // provided pends and fires when they are — NOT silently dropped. This is
  // what registerAccessProvider's deferred-mount discipline is FOR; an
  // order-dependent mock would never exercise it.
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
      if (key === 'opsAccess') handle = value
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
  }
  apply(ctx, { registryFile, rwRegistryFile })
  return {
    handle: handle!,
    listeners,
    routes,
    /** Drive the mention-candidate route; parses the JSON body. */
    async listRoute(query = ''): Promise<{ status: number, body: any }> {
      const route = routes.find((r) => r.path === '/ops-access/list')
      if (!route) return { status: 404, body: null }
      let status = 0
      let body: any = null
      await route.handler(
        { url: `/ops-access/list?query=${encodeURIComponent(query)}` },
        { writeHead: (s: number) => { status = s }, end: (text: string) => { body = JSON.parse(text) } },
      )
      return { status, body }
    },
    dir,
    registryFile,
    rwRegistryFile,
    write: (text: string) => writeFileSync(registryFile, text),
    writeRw: (text: string) => writeFileSync(rwRegistryFile, text),
  }
}
