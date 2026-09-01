/**
 * Test harness for ops-tool-kubectl: mounts the plugin against a minimal mock
 * context and captures the three surfaces the plugin touches — opsAccess
 * (programmable resolve/list), shell (captures every resolve request, run
 * returns a programmable result), and tools.register (captures definitions).
 */

import { apply } from '../src/index.ts'
import type { AccessProfile, AdminEntry } from '@deepseek-ai/dsh-ops-access'

export const DEFAULT_KUBECONFIG = '/home/test/.kube/prod.yaml'

export const DEFAULT_PROFILE: AccessProfile = {
  kind: 'k8s',
  name: 'prod',
  tier: 'ro',
  description: '生产集群',
  environment: 'prod',
  fields: { kubeconfigPath: DEFAULT_KUBECONFIG },
}

export interface ShellRunOutcome {
  exitCode: number | null
  stdoutText: string
  stderrText: string
}

export function setup(opts: {
  resolveImpl?: (kind: string, name: string) => Promise<AccessProfile>
  listAllImpl?: () => Promise<AdminEntry[]>
  runImpl?: (spec: any) => Promise<ShellRunOutcome>
} = {}) {
  const tools: any[] = []
  const effectCleanups: Array<() => void> = []
  /** Every request handed to shell.resolve, in order. */
  const shellRequests: any[] = []
  /** Every spec handed to shell.run, in order. */
  const shellRuns: any[] = []

  const calls = { resolve: 0, listAll: 0, shellResolve: 0, shellRun: 0 }

  const opsAccess = {
    register: () => () => {},
    resolve: (kind: string, name: string) => {
      calls.resolve++
      return (opts.resolveImpl ?? (async () => DEFAULT_PROFILE))(kind, name)
    },
    listAll: () => {
      calls.listAll++
      return (opts.listAllImpl ?? (async () => []))()
    },
    help: () => 'REGISTRY HELP DOC',
  }

  const ctx: any = {
    get: (key: string) => key === 'opsAccess' ? opsAccess : undefined,
    shell: {
      resolve: (request: any) => {
        calls.shellResolve++
        shellRequests.push(request)
        return { workdir: '/tmp', stdoutMaxBytes: 1024 * 1024, sandboxPolicy: undefined, ...request }
      },
      run: async (spec: any) => {
        calls.shellRun++
        shellRuns.push(spec)
        const outcome = await (opts.runImpl ?? (async () => ({ exitCode: 0, stdoutText: 'NAME\tREADY\npod-a\t1/1\n', stderrText: '' })))(spec)
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
        // Real disposer: removes the tool, so HMR-unload tests see the surface shrink.
        return () => {
          const i = tools.indexOf(t)
          if (i !== -1) tools.splice(i, 1)
        }
      },
    },
  }

  apply(ctx, { timeoutMs: 30000 })

  const kubectl = tools.find((t) => t.name === 'kubectl')
  const listAccess = tools.find((t) => t.name === 'list_access')

  /** Fresh exec context with a real AbortSignal, so tests can assert passthrough. */
  const exec = () => ({ signal: new AbortController().signal })
  const runKubectl = (args: Record<string, unknown>, e = exec()) =>
    kubectl.execute(args, e).then((value: any) => ({ value, exec: e }))
  const renderKubectl = (args: Record<string, unknown>, value: any): string =>
    kubectl.output.render(args, value)[0].text
  const runListAccess = (args: Record<string, unknown> = {}) => listAccess.execute(args, exec())
  const renderListAccess = (value: any): string =>
    listAccess.output.render({}, value)[0].text

  return {
    tools, kubectl, listAccess,
    runKubectl, renderKubectl, runListAccess, renderListAccess,
    shellRequests, shellRuns, calls, effectCleanups,
  }
}
