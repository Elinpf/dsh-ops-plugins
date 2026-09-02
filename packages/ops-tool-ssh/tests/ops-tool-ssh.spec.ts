import { describe, expect, it } from 'vitest'
import * as mod from '../src/index.ts'
import { shellQuote } from '@elinpf/dsh-ops-shell-tool'
import { setup, DEFAULT_PROFILE } from './harness.ts'
import type { AccessProfile } from '@elinpf/dsh-ops-access'

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect(mod.name).toBe('ops-tool-ssh')
    expect(mod.inject).toEqual(['shell', 'tools'])
    expect(mod.Config).toBeDefined()
    expect(typeof mod.apply).toBe('function')
    expect((mod as any).default).toBeUndefined()
  })
})

describe('HMR unload', () => {
  it('running every collected disposer removes the ssh tool from the registry', () => {
    const h = setup()
    expect(h.tools.map((t: any) => t.name)).toEqual(['ssh'])
    expect(h.effectCleanups.length).toBeGreaterThan(0)
    for (const dispose of h.effectCleanups) dispose()
    expect(h.tools.find((t: any) => t.name === 'ssh')).toBeUndefined()
    expect(h.tools).toHaveLength(0)
    // Disposal is idempotent: a second pass is a no-op.
    for (const dispose of h.effectCleanups) dispose()
    expect(h.tools).toHaveLength(0)
  })
})

describe('ssh', () => {
  it('happy path: resolves the profile, assembles the command, maps the result', async () => {
    const h = setup()
    const { value, exec } = await h.runSsh({ host: 'node-1', command: 'systemctl status ceph-osd@3' })
    expect(h.calls.resolve).toBe(1)
    expect(h.calls.shellRun).toBe(1)
    expect(value.command).toBe(
      'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new'
      + ' -i <node-1@ro:key> -p 2222 ops@10.0.0.11 \'systemctl status ceph-osd@3\'',
    )
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('active\n')
    // 30s timeout and the exec AbortSignal pass through to the shell service
    expect(h.shellRequests[0].timeoutMs).toBe(30000)
    expect(h.shellRequests[0].signal).toBe(exec.signal)
  })

  it('resolves the profile with kind "ssh" and the given host name', async () => {
    const seen: Array<[string, string]> = []
    const h = setup({
      resolveImpl: async (kind, name) => { seen.push([kind, name]); return DEFAULT_PROFILE },
    })
    await h.runSsh({ host: 'node-9', command: 'uptime' })
    expect(seen).toEqual([['ssh', 'node-9']])
  })

  it('optional fields: no key / no port omits -i and -p', async () => {
    const minimal: AccessProfile = {
      kind: 'ssh', name: 'jump', tier: 'ro', fields: { host: '192.168.1.2', user: 'root' },
    }
    const h = setup({ profile: minimal })
    const { value } = await h.runSsh({ host: 'jump', command: 'hostname' })
    expect(value.command).toBe(
      'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new root@192.168.1.2 \'hostname\'',
    )
  })

  it('compound commands run REMOTE: the whole string is one quoted argument', async () => {
    const h = setup()
    const cmd = 'mv a b && mv b c && echo done'
    const { value } = await h.runSsh({ host: 'node-1', command: cmd })
    // display: readable, quoted as a single remote argument
    expect(value.command.endsWith('ops@10.0.0.11 \'mv a b && mv b c && echo done\'')).toBe(true)
    // executable: the quoted remote argument survives credential substitution
    const run = h.shellRequests[0].command
    expect(run.endsWith('\'' + cmd + '\'')).toBe(true)
    // no unquoted metacharacter after the host part — nothing for the local shell to split
    expect(run.split('ops@10.0.0.11 ')[1]).toBe('\'' + cmd + '\'')
  })

  it('embedded single quotes escape POSIX-style and stay remote', async () => {
    const h = setup()
    const cmd = 'grep \'active\' /var/log/x'
    const { value } = await h.runSsh({ host: 'node-1', command: cmd })
    expect(value.command.endsWith(shellQuote(cmd))).toBe(true)
    expect(h.shellRequests[0].command.endsWith(shellQuote(cmd))).toBe(true)
  })

  it('$() and redirects stay inside the quotes (expanded on the remote host)', async () => {
    const h = setup()
    const cmd = 'echo $(hostname) > /tmp/h'
    const { value } = await h.runSsh({ host: 'node-1', command: cmd })
    expect(value.command.endsWith('\'' + cmd + '\'')).toBe(true)
  })

  it('normalizes a null exitCode (signal death) to -1', async () => {
    const h = setup({ runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: '' }) })
    const { value } = await h.runSsh({ host: 'node-1', command: 'uptime' })
    expect(value.exitCode).toBe(-1)
  })

  it('unknown host name: resolve error passes through, shell untouched', async () => {
    const h = setup({
      resolveImpl: async () => { throw new Error('unknown ssh profile "nope". Available: node-1') },
    })
    const { value } = await h.runSsh({ host: 'nope', command: 'uptime' })
    expect(value.error).toContain('unknown ssh profile "nope"')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.shellRun).toBe(0)
  })

  it('shell.run throwing falls back to an error result', async () => {
    const h = setup({ runImpl: async () => { throw new Error('spawn ssh ENOENT') } })
    const { value } = await h.runSsh({ host: 'node-1', command: 'uptime' })
    expect(value.error).toBe('spawn ssh ENOENT')
    expect(value.exitCode).toBe(-1)
  })

  it('ops-access absent: clean error, shell untouched', async () => {
    const h = setup({ withOpsAccess: false })
    const { value } = await h.runSsh({ host: 'node-1', command: 'uptime' })
    expect(value.error).toContain('ops-access service unavailable')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.shellRun).toBe(0)
  })

  it('render is a pure function of (args, value)', async () => {
    const h = setup()
    const { value } = await h.runSsh({ host: 'node-1', command: 'uptime' })
    const a = h.renderSsh({ host: 'node-1', command: 'uptime' }, value)
    const b = h.renderSsh({ host: 'node-1', command: 'uptime' }, value)
    expect(a).toBe(b)
    expect(a).toContain('$ ssh -o BatchMode=yes')
    expect(a).toContain('active')
    const err = h.renderSsh({}, { exitCode: 255, stdout: '', stderr: 'Connection refused', command: 'ssh x' })
    expect(err).toContain('[stderr]')
    expect(err).toContain('[exit code: 255]')
  })
})
