/**
 * Test harness for ops-tool-ssh: mounts the plugin against a minimal mock
 * context and captures the surfaces the plugin touches — opsAccess
 * (programmable resolve), shell (captures every resolve request, run
 * returns a programmable result), and tools.register (captures definitions).
 */

import { apply } from '../src/index.ts'
import type { AccessProfile } from '@deepseek-ai/dsh-ops-access'

export const DEFAULT_PROFILE: AccessProfile = {
  kind: 'ssh',
  name: 'node-1',
  tier: 'ro',
  description: '生产节点 1',
  environment: 'prod',
  fields: { host: '10.0.0.11', user: 'ops', key: '/home/test/.ssh/id_ed25519', port: 2222 },
}

export interface ShellRunOutcome {
  exitCode: number | null
  stdoutText: string
  stderrText: string
}

export function setup(opts: {
  profile?: AccessProfile
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
      return (opts.resolveImpl ?? (async () => opts.profile ?? DEFAULT_PROFILE))(kind, name)
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
        const outcome = await (opts.runImpl ?? (async () => ({ exitCode: 0, stdoutText: 'active\n', stderrText: '' })))(spec)
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
        return () => {
          const i = tools.indexOf(t)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
  }

  apply(ctx, { timeoutMs: 30000, connectTimeoutSeconds: 10 })

  const ssh = tools.find((t) => t.name === 'ssh')

  /** Fresh exec context with a real AbortSignal, so tests can assert passthrough. */
  const exec = () => ({ signal: new AbortController().signal })
  const runSsh = (args: Record<string, unknown>, e = exec()) =>
    ssh.execute(args, e).then((value: any) => ({ value, exec: e }))
  const renderSsh = (args: Record<string, unknown>, value: any): string =>
    ssh.output.render(args, value)[0].text

  return { tools, ssh, runSsh, renderSsh, shellRequests, shellRuns, calls, effectCleanups }
}
