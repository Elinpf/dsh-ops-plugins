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
  const wctx = {
    effect: (fn: () => () => void) => { fn() },
    webServer: { register: (route: any) => { routes.push(route); return () => {} } },
  }
  const ctx: any = {
    provide: (key: string, value: any) => { if (key === 'opsAccess') handle = value },
    on: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => {
      listeners.push({ event, listener, options })
      return () => {}
    },
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.includes('webServer')) cb(wctx)
      if (deps.includes('opsAccess') && handle) cb({ ...ctx, opsAccess: handle, effect: (fn: () => () => void) => { fn() } })
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
