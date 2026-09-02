/**
 * Test harness for ops-tool-ceph: mounts the plugin against a minimal mock
 * context and captures the surfaces the plugin touches — opsAccess
 * (programmable resolve), shell (captures every resolve request, run
 * returns a programmable result), and tools.register (captures definitions).
 */

import { apply } from '../src/index.ts'
import type { AccessProfile } from '@elinpf/dsh-ops-access'

export const DEFAULT_PROFILE: AccessProfile = {
  kind: 'ceph',
  name: 'prod',
  tier: 'ro',
  description: '生产 Ceph 集群',
  environment: 'prod',
  fields: { conf: '/etc/ceph/prod.conf', keyring: '/etc/ceph/prod.keyring' },
}

export interface ShellRunOutcome {
  exitCode: number | null
  stdoutText: string
  stderrText: string
}

export function setup(opts: {
  resolveImpl?: (kind: string, name: string) => Promise<AccessProfile>
  runImpl?: (spec: any) => Promise<ShellRunOutcome>
  withOpsAccess?: boolean
} = {}) {
  const tools: any[] = []
  const effectCleanups: Array<() => void> = []
  /** Every request handed to shell.resolve, in order. */
  const shellRequests: any[] = []
  /** Every spec handed to shell.run, in order. */
  const shellRuns: any[] = []

  const calls = { resolve: 0, shellResolve: 0, shellRun: 0 }

  const opsAccess = {
    register: () => () => {},
    resolve: (kind: string, name: string) => {
      calls.resolve++
      return (opts.resolveImpl ?? (async () => DEFAULT_PROFILE))(kind, name)
    },
    list: async () => [],
  }

  const ctx: any = {
    get: (key: string) => key === 'opsAccess' && opts.withOpsAccess !== false ? opsAccess : undefined,
    shell: {
      resolve: (request: any) => {
        calls.shellResolve++
        shellRequests.push(request)
        return { workdir: '/tmp', stdoutMaxBytes: 1024 * 1024, sandboxPolicy: undefined, ...request }
      },
      run: async (spec: any) => {
        calls.shellRun++
        shellRuns.push(spec)
        const outcome = await (opts.runImpl ?? (async () => ({ exitCode: 0, stdoutText: 'HEALTH_OK\n', stderrText: '' })))(spec)
        return {
          exitCode: outcome.exitCode,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: outcome.stdoutText },
          stderr: { text: outcome.stderrText },
        }
      },
    },
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

  apply(ctx, { timeoutMs: 30000 })

  const ceph = tools.find((t) => t.name === 'ceph')

  /** Fresh exec context with a real AbortSignal, so tests can assert passthrough. */
  const exec = () => ({ signal: new AbortController().signal })
  const runCeph = (args: Record<string, unknown>, e = exec()) =>
    ceph.execute(args, e).then((value: any) => ({ value, exec: e }))
  const renderCeph = (args: Record<string, unknown>, value: any): string =>
    ceph.output.render(args, value)[0].text

  return { tools, ceph, runCeph, renderCeph, shellRequests, shellRuns, calls, effectCleanups }
}
