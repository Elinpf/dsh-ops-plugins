/**
 * ops-shell-tool spec: drives the factory through a mock ctx, covering the
 * shared execute template (resolve-per-call, absent-seam guard, error
 * passthrough, exitCode normalization, timeout/signal passthrough) and the
 * shared render.
 */

import { describe, expect, it } from 'vitest'
import { registerProfiledShellTool } from '../src/index.ts'
import type { ProfiledShellToolSpec } from '../src/index.ts'
import type { AccessProfile } from '@deepseek-ai/dsh-ops-access'

const SPEC: ProfiledShellToolSpec = {
  name: 'widget',
  kind: 'widget',
  targetParam: 'target',
  description: 'Run widgetctl.',
  targetParamDescription: 'Widget profile name.',
  commandDescription: 'widgetctl subcommand.',
  buildCommand: (fields, command) => `widgetctl --sock="${fields.sockPath}" ${command}`,
}

const PROFILE: AccessProfile = {
  kind: 'widget', name: 'prod', fields: { sockPath: '/run/widget.sock' },
}

interface ShellRunOutcome {
  exitCode: number | null
  stdoutText: string
  stderrText: string
}

function setup(opts: {
  resolveImpl?: (kind: string, name: string, agent?: { id: string }) => Promise<AccessProfile>
  runImpl?: (spec: any) => Promise<ShellRunOutcome>
  withOpsAccess?: boolean
} = {}) {
  const tools: any[] = []
  const effectCleanups: Array<() => void> = []
  const shellRequests: any[] = []
  const calls = { resolve: 0, shellRun: 0 }

  const opsAccess = {
    resolve: (kind: string, name: string, agent?: { id: string }) => {
      calls.resolve++
      return (opts.resolveImpl ?? (async () => PROFILE))(kind, name, agent)
    },
  }

  const ctx: any = {
    get: (key: string) => key === 'opsAccess' && opts.withOpsAccess !== false ? opsAccess : undefined,
    shell: {
      resolve: (request: any) => { shellRequests.push(request); return { ...request } },
      run: async (spec: any) => {
        calls.shellRun++
        const outcome = await (opts.runImpl ?? (async () => ({ exitCode: 0, stdoutText: 'ok\n', stderrText: '' })))(spec)
        return {
          exitCode: outcome.exitCode,
          stdout: { text: outcome.stdoutText },
          stderr: { text: outcome.stderrText },
        }
      },
    },
    effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    tools: { register: (t: any) => { tools.push(t); return () => {} } },
  }

  registerProfiledShellTool(ctx, SPEC)
  const tool = tools[0]
  const exec = (agent?: { id: string }) => ({ signal: new AbortController().signal, agent })
  return { tools, tool, shellRequests, calls, effectCleanups, exec }
}

describe('registerProfiledShellTool', () => {
  it('registers one tool under the spec name, disposed with the fiber effect', () => {
    const { tools, tool, effectCleanups } = setup()
    expect(tools).toHaveLength(1)
    expect(tool.name).toBe('widget')
    expect(effectCleanups).toHaveLength(1)
  })

  it('declares exactly the target param and the command param', () => {
    const { tool } = setup()
    // defineTool normalizes parameters into JSON-schema shape.
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['command', 'target'])
    expect([...tool.parameters.required].sort()).toEqual(['command', 'target'])
  })

  it('happy path: resolves kind+target, builds the command, maps the result', async () => {
    const seen: Array<[string, string]> = []
    const h = setup({
      resolveImpl: async (kind, name) => { seen.push([kind, name]); return PROFILE },
    })
    const e = h.exec()
    const value = await h.tool.execute({ target: 'prod', command: 'status --wide' }, e)
    expect(seen).toEqual([['widget', 'prod']])
    expect(value.command).toBe('widgetctl --sock="/run/widget.sock" status --wide')
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('ok\n')
    expect(h.shellRequests[0].timeoutMs).toBe(30000)
    expect(h.shellRequests[0].signal).toBe(e.signal)
  })

  it('forwards exec.agent into opsAccess.resolve (the gate keys grants on it)', async () => {
    const seen: Array<{ kind: string, name: string, agent: unknown }> = []
    const h = setup({
      resolveImpl: async (kind, name, agent) => { seen.push({ kind, name, agent }); return PROFILE },
    })
    const agent = { id: 'sess-1' }
    await h.tool.execute({ target: 'prod', command: 'status' }, h.exec(agent))
    expect(seen).toEqual([{ kind: 'widget', name: 'prod', agent }])
  })

  it('resolve is called with undefined agent when exec carries none', async () => {
    const seen: Array<unknown> = []
    const h = setup({
      resolveImpl: async (_kind, _name, agent) => { seen.push(agent); return PROFILE },
    })
    await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    expect(seen).toEqual([undefined])
  })

  it('normalizes a null exitCode (signal death) to -1', async () => {
    const h = setup({ runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: '' }) })
    const value = await h.tool.execute({ target: 'prod', command: 'x' }, h.exec())
    expect(value.exitCode).toBe(-1)
  })

  it('unknown profile: resolve error passes through verbatim, shell untouched', async () => {
    const h = setup({
      resolveImpl: async () => { throw new Error('unknown widget profile "nope". Available: prod') },
    })
    const value = await h.tool.execute({ target: 'nope', command: 'x' }, h.exec())
    expect(value.error).toContain('unknown widget profile "nope"')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.shellRun).toBe(0)
  })

  it('shell.run throwing falls back to an error result', async () => {
    const h = setup({ runImpl: async () => { throw new Error('spawn widgetctl ENOENT') } })
    const value = await h.tool.execute({ target: 'prod', command: 'x' }, h.exec())
    expect(value.error).toBe('spawn widgetctl ENOENT')
    expect(value.exitCode).toBe(-1)
  })

  it('ops-access absent: clean error, shell untouched', async () => {
    const h = setup({ withOpsAccess: false })
    const value = await h.tool.execute({ target: 'prod', command: 'x' }, h.exec())
    expect(value.error).toContain('ops-access service unavailable')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.shellRun).toBe(0)
  })

  it('render is a pure function of (args, value)', async () => {
    const h = setup()
    const value = await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    const a = tool_text(h.tool, value)
    const b = tool_text(h.tool, value)
    expect(a).toBe(b)
    expect(a).toContain('$ widgetctl --sock="/run/widget.sock" status')
    expect(a).toContain('ok')
    const err = tool_text(h.tool, { exitCode: 2, stdout: '', stderr: 'boom', command: 'widgetctl x' })
    expect(err).toContain('[stderr]')
    expect(err).toContain('[exit code: 2]')
    const failed = tool_text(h.tool, { exitCode: -1, stdout: '', stderr: 'm', command: '', error: 'm' })
    expect(failed).toContain('[error] m')
  })
})

function tool_text(tool: any, value: any): string {
  return tool.output.render({}, value)[0].text
}
