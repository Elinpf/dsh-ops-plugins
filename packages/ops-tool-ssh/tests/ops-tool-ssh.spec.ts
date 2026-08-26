import { describe, expect, it } from 'vitest'
import * as mod from '../src/index.ts'
import { setup, DEFAULT_PROFILE } from './harness.ts'
import type { AccessProfile } from '@deepseek-ai/dsh-ops-access'

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect(mod.name).toBe('ops-tool-ssh')
    expect(mod.inject).toEqual(['shell', 'tools'])
    expect(mod.Config).toBeDefined()
    expect(typeof mod.apply).toBe('function')
    expect((mod as any).default).toBeUndefined()
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
      + ' -i "/home/test/.ssh/id_ed25519" -p 2222 ops@10.0.0.11 systemctl status ceph-osd@3',
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
      kind: 'ssh', name: 'jump', fields: { host: '192.168.1.2', user: 'root' },
    }
    const h = setup({ profile: minimal })
    const { value } = await h.runSsh({ host: 'jump', command: 'hostname' })
    expect(value.command).toBe(
      'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new root@192.168.1.2 hostname',
    )
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
