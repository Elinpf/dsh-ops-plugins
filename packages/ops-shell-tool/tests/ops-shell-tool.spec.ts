/**
 * ops-shell-tool spec: drives the factory through a mock ctx, covering the
 * shared execute template (resolve-per-call, absent-seam guard, error
 * passthrough, exitCode normalization, timeout/signal passthrough) and the
 * shared render.
 */

import { describe, expect, it } from 'vitest'
import { registerProfiledShellTool, shellQuote } from '../src/index.ts'
import type { ProfiledShellToolSpec } from '../src/index.ts'
import type { AccessProfile } from '@deepseek-ai/dsh-ops-access'

const SPEC: ProfiledShellToolSpec = {
  name: 'widget',
  kind: 'widget',
  targetParam: 'target',
  description: 'Run widgetctl.',
  targetParamDescription: 'Widget profile name.',
  commandDescription: 'widgetctl subcommand.',
  buildCommand: (fields, command, ref) => `widgetctl --sock=${ref('sockPath')} ${command}`,
}

const PROFILE: AccessProfile = {
  kind: 'widget', name: 'prod', tier: 'ro', fields: { sockPath: '/run/widget.sock' },
}

interface ShellRunOutcome {
  exitCode: number | null
  stdoutText: string
  stderrText: string
  timedOut?: boolean
  aborted?: boolean
  timeoutMs?: number
  signal?: string
}

function setup(opts: {
  resolveImpl?: (kind: string, name: string, agent?: { id: string }) => Promise<AccessProfile>
  runImpl?: (spec: any) => Promise<ShellRunOutcome>
  withOpsAccess?: boolean
  spec?: Partial<ProfiledShellToolSpec>
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
          timedOut: outcome.timedOut,
          aborted: outcome.aborted,
          timeoutMs: outcome.timeoutMs,
          signal: outcome.signal,
          stdout: { text: outcome.stdoutText },
          stderr: { text: outcome.stderrText },
        }
      },
    },
    effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    tools: { register: (t: any) => { tools.push(t); return () => {} } },
  }

  registerProfiledShellTool(ctx, { ...SPEC, ...opts.spec })
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
    // The result (model-visible, logged) shows the credential token…
    expect(value.command).toBe('widgetctl --sock=<prod@ro:sockPath> status --wide')
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('ok\n')
    // …while the executed command carries the real, shell-quoted value.
    expect(h.shellRequests[0].command).toBe("widgetctl --sock='/run/widget.sock' status --wide")
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

  it('a signal death always names its cause (signal or unknown), never a bare -1', async () => {
    const killed = setup({ runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: '', signal: 'SIGKILL' }) })
    const kv = await killed.tool.execute({ target: 'prod', command: 'x' }, killed.exec())
    expect(kv.exitCode).toBe(-1)
    expect(kv.error).toContain('killed by signal SIGKILL')
    expect(kv.error).toContain('terminated externally')
    expect(kv.error).not.toContain('timeout')

    const unnamed = setup({ runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: '' }) })
    const uv = await unnamed.tool.execute({ target: 'prod', command: 'x' }, unnamed.exec())
    expect(uv.exitCode).toBe(-1)
    expect(uv.error).toContain('unknown')
    expect(uv.error).not.toContain('timeout')
  })

  it('a timeout kill says so: seconds, partial-effect warning, faster-failure advice', async () => {
    const h = setup({
      runImpl: async () => ({ exitCode: null, stdoutText: 'pod x deleted\n', stderrText: '', timedOut: true, timeoutMs: 30000 }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'delete pod x' }, h.exec())
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('killed')
    expect(value.error).toContain('30s')
    expect(value.error).toContain('partially taken effect')
    expect(value.error).toContain('wget -T N')
    // partial output survives the kill — the deleted line must not be swallowed
    expect(value.stdout).toBe('pod x deleted\n')
  })

  it('a caller abort says so without masquerading as a timeout', async () => {
    const h = setup({ runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: '', aborted: true }) })
    const value = await h.tool.execute({ target: 'prod', command: 'x' }, h.exec())
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('aborted')
    expect(value.error).not.toContain('timeout')
  })

  it('the render surfaces the kill note through the error field', async () => {
    const h = setup({
      runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: '', timedOut: true, timeoutMs: 30000 }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'x' }, h.exec())
    const text = tool_text(h.tool, value)
    expect(text).toContain('[error] killed: exceeded the 30s tool timeout')
    expect(text).toContain('[exit code: -1]')
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
    expect(a).toContain('$ widgetctl --sock=<prod@ro:sockPath> status')
    expect(a).toContain('ok')
    const err = tool_text(h.tool, { exitCode: 2, stdout: '', stderr: 'boom', command: 'widgetctl x' })
    expect(err).toContain('[stderr]')
    expect(err).toContain('[exit code: 2]')
    const failed = tool_text(h.tool, { exitCode: -1, stdout: '', stderr: 'm', command: '', error: 'm' })
    expect(failed).toContain('[error] m')
  })

})

describe('credential reference tokens', () => {
  it('display carries <id@tier:field>; the executed command carries the shell-quoted real value', async () => {
    const h = setup({ resolveImpl: async () => ({ ...PROFILE, tier: 'rw' }) })
    const value = await h.tool.execute({ target: 'prod', command: 'restart' }, h.exec())
    expect(value.command).toBe('widgetctl --sock=<prod@rw:sockPath> restart')
    expect(h.shellRequests[0].command).toBe("widgetctl --sock='/run/widget.sock' restart")
    // No token bracket leaks into the executed command.
    expect(h.shellRequests[0].command).not.toContain('<')
    expect(h.shellRequests[0].command).not.toContain('>')
  })

  it('scrubs credential values out of captured stdout and stderr', async () => {
    // CLIs echo their flag values in errors — the path must still not leak.
    const h = setup({
      runImpl: async () => ({
        exitCode: 1,
        stdoutText: 'using config /run/widget.sock\n',
        stderrText: 'dial /run/widget.sock: connect failed\n',
      }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    expect(value.stdout).toBe('using config <prod@ro:sockPath>\n')
    expect(value.stderr).toBe('dial <prod@ro:sockPath>: connect failed\n')
    expect(JSON.stringify(value)).not.toContain('/run/widget.sock')
  })

  it('scrubs a real path the model pasted into its own command arg', async () => {
    const h = setup()
    const value = await h.tool.execute({ target: 'prod', command: 'status --config=/run/widget.sock' }, h.exec())
    // Display: the literal path becomes the token. Executed: still valid.
    expect(value.command).toBe('widgetctl --sock=<prod@ro:sockPath> status --config=<prod@ro:sockPath>')
    // The scrubbed token substitutes back to the quoted path, like any ref.
    expect(h.shellRequests[0].command).toBe("widgetctl --sock='/run/widget.sock' status --config='/run/widget.sock'")
  })

  it('ref() on a missing field fails the call before any shell execution', async () => {
    const h = setup({
      resolveImpl: async () => ({ ...PROFILE, fields: {} }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    expect(value.error).toContain('field "sockPath" is not a non-empty string')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.shellRun).toBe(0)
  })
})

describe('stderrNoise filtering', () => {
  const NOISE = [/^noise:/]

  it('drops stderr lines matching a declared noise pattern, keeps the rest', async () => {
    const h = setup({
      spec: { stderrNoise: NOISE },
      runImpl: async () => ({
        exitCode: 0,
        stdoutText: 'ok\n',
        stderrText: 'noise: chatter\nreal warning\nnoise: more chatter\n',
      }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    expect(value.stderr).toBe('real warning\n')
    expect(value.stdout).toBe('ok\n')
  })

  it('all-noise stderr becomes empty; the trailing newline is not a line', async () => {
    const h = setup({
      spec: { stderrNoise: NOISE },
      runImpl: async () => ({ exitCode: 0, stdoutText: '', stderrText: 'noise: a\nnoise: b\n' }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    expect(value.stderr).toBe('')
  })

  it('no patterns declared: stderr passes through verbatim', async () => {
    const h = setup({
      runImpl: async () => ({ exitCode: 0, stdoutText: '', stderrText: 'noise: a\nreal\n' }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    expect(value.stderr).toBe('noise: a\nreal\n')
  })

  it('filtering happens after credential scrubbing (tokens stay intact)', async () => {
    const h = setup({
      spec: { stderrNoise: NOISE },
      runImpl: async () => ({
        exitCode: 1,
        stdoutText: '',
        stderrText: 'noise: about /run/widget.sock\ndial /run/widget.sock: failed\n',
      }),
    })
    const value = await h.tool.execute({ target: 'prod', command: 'status' }, h.exec())
    expect(value.stderr).toBe('dial <prod@ro:sockPath>: failed\n')
    expect(JSON.stringify(value)).not.toContain('/run/widget.sock')
  })
})

describe('shellQuote', () => {
  it('wraps in single quotes with POSIX escaping for embedded quotes', () => {
    expect(shellQuote('plain')).toBe('\'plain\'')
    expect(shellQuote('a\'b')).toBe('\'a\'\\\'\'b\'')
    expect(shellQuote('')).toBe('\'\'')
  })
})

function tool_text(tool: any, value: any): string {
  return tool.output.render({}, value)[0].text
}
