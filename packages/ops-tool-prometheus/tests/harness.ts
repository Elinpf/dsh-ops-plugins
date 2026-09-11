/**
 * Test harness for ops-tool-prometheus: mounts the tool against a minimal
 * mock context and a fake Prometheus server — opsAccess (programmable
 * resolve), tools.register (captures definitions), and an injected fetchFn
 * that records every request and returns a programmable response. No network.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, createPrometheusTool } from '../src/index.ts'
import type { AccessProfile } from '@elinpf/dsh-ops-access'
import { mktmpdir } from './tmpdir.ts'

export const DEFAULT_PROFILE: AccessProfile = {
  kind: 'prometheus',
  name: 'prod',
  tier: 'ro',
  description: '生产 Prometheus',
  environment: 'prod',
  fields: { url: 'http://prom.example.com:9090' },
}

export interface FakeCall {
  url: string
  headers: Record<string, string>
  signal: AbortSignal | undefined
}

export type FakeFetch = (url: string, init: { headers?: Record<string, string>, signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
}>

/** A fake fetch resolving a JSON body (Prometheus envelope or anything else). */
export function jsonResponse(body: unknown, status = 200): ReturnType<FakeFetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  })
}

/** A fake fetch resolving a non-JSON body (a proxy error page, say). */
export function textResponse(text: string, status: number, statusText = ''): ReturnType<FakeFetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => text,
  })
}

export function setup(opts: {
  resolveImpl?: (kind: string, name: string) => Promise<AccessProfile>
  fetchImpl?: FakeFetch
  withOpsAccess?: boolean
  /** When set, the default profile carries this token file path. */
  tokenFile?: string
} = {}) {
  const tools: any[] = []
  const effectCleanups: Array<() => void> = []
  /** Every fetch call, in order. */
  const fetchCalls: FakeCall[] = []

  const calls = { resolve: 0, fetch: 0 }

  const defaultProfile: AccessProfile = opts.tokenFile
    ? { ...DEFAULT_PROFILE, fields: { ...DEFAULT_PROFILE.fields, token: opts.tokenFile } }
    : DEFAULT_PROFILE

  const opsAccess = {
    register: () => () => {},
    resolve: (kind: string, name: string) => {
      calls.resolve++
      return (opts.resolveImpl ?? (async () => defaultProfile))(kind, name)
    },
    list: async () => [],
  }

  const defaultFetchImpl: FakeFetch = () => jsonResponse({
    status: 'success',
    data: { resultType: 'vector', result: [{ metric: { __name__: 'up', instance: 'localhost:9090', job: 'prometheus' }, value: [1757582400, '1'] }] },
  })

  const fetchFn: typeof fetch = (async (url: any, init: any) => {
    calls.fetch++
    fetchCalls.push({ url: String(url), headers: init?.headers ?? {}, signal: init?.signal })
    return (opts.fetchImpl ?? defaultFetchImpl)(String(url), init)
  }) as typeof fetch

  const ctx: any = {
    get: (key: string) => key === 'opsAccess' && opts.withOpsAccess !== false ? opsAccess : undefined,
    effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    tools: {
      register: (t: any) => {
        tools.push(t)
        // Real disposer: unregister removes the tool, mirroring the runtime.
        return () => {
          const i = tools.indexOf(t)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
  }

  // The tool under test carries the fake fetch; apply() itself is covered by
  // the registration/HMR tests, which never execute a query.
  const tool = createPrometheusTool(ctx, { timeoutMs: 30000 }, { fetchFn })
  tools.push(tool)

  /** Register through the real plugin entry (uses the global fetch — do not execute). */
  const applyPlugin = () => apply(ctx, { timeoutMs: 30000 })

  const runProm = (args: Record<string, unknown>, exec: any = { signal: new AbortController().signal }) =>
    (tool as any).execute(args, exec)
  const renderProm = (args: Record<string, unknown>, value: any): string =>
    (tool as any).output.render(args, value)[0].text

  return { tools, tool, runProm, renderProm, applyPlugin, fetchCalls, calls, effectCleanups }
}

/** Write a bearer-token file in a tracked temp dir; returns its path. */
export function writeTokenFile(content: string): string {
  const dir = mktmpdir('ops-prom-token-')
  const path = join(dir, 'token')
  writeFileSync(path, content, { mode: 0o600 })
  return path
}
