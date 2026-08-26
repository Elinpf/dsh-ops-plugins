import { describe, expect, it } from 'vitest'
import * as mod from '../src/index.ts'
import { setup, DEFAULT_PROFILE } from './harness.ts'

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect(mod.name).toBe('ops-tool-ceph')
    expect(mod.inject).toEqual(['shell', 'tools'])
    expect(mod.Config).toBeDefined()
    expect(typeof mod.apply).toBe('function')
    expect((mod as any).default).toBeUndefined()
  })
})

describe('ceph', () => {
  it('happy path: resolves the profile, assembles the command, maps the result', async () => {
    const h = setup()
    const { value, exec } = await h.runCeph({ cluster: 'prod', command: 'health detail' })
    expect(h.calls.resolve).toBe(1)
    expect(h.calls.shellResolve).toBe(1)
    expect(h.calls.shellRun).toBe(1)
    expect(value.command).toBe('ceph --conf="/etc/ceph/prod.conf" --keyring="/etc/ceph/prod.keyring" health detail')
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('HEALTH_OK\n')
    // 30s timeout and the exec AbortSignal pass through to the shell service
    expect(h.shellRequests[0].timeoutMs).toBe(30000)
    expect(h.shellRequests[0].signal).toBe(exec.signal)
  })

  it('resolves the profile with kind "ceph" and the given cluster name', async () => {
    const seen: Array<[string, string]> = []
    const h = setup({
      resolveImpl: async (kind, name) => { seen.push([kind, name]); return DEFAULT_PROFILE },
    })
    await h.runCeph({ cluster: 'staging', command: 'df' })
    expect(seen).toEqual([['ceph', 'staging']])
  })

  it('injects --name when the profile carries a cephx user', async () => {
    const h = setup({
      resolveImpl: async () => ({
        kind: 'ceph', name: 'rook-test',
        fields: { conf: '/etc/ceph/rook.conf', keyring: '/etc/ceph/rook.keyring', name: 'client.dsh-test' },
      }),
    })
    const { value } = await h.runCeph({ cluster: 'rook-test', command: 'fsid' })
    expect(value.command).toBe('ceph --conf="/etc/ceph/rook.conf" --keyring="/etc/ceph/rook.keyring" --name client.dsh-test fsid')
  })

  it('normalizes a null exitCode (signal death) to -1', async () => {
    const h = setup({ runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: '' }) })
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    expect(value.exitCode).toBe(-1)
  })

  it('unknown cluster name: resolve error passes through, shell untouched', async () => {
    const h = setup({
      resolveImpl: async () => { throw new Error('unknown ceph profile "nope". Available: prod') },
    })
    const { value } = await h.runCeph({ cluster: 'nope', command: 'health' })
    expect(value.error).toContain('unknown ceph profile "nope"')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.shellRun).toBe(0)
  })

  it('shell.run throwing falls back to an error result', async () => {
    const h = setup({ runImpl: async () => { throw new Error('spawn ceph ENOENT') } })
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    expect(value.error).toBe('spawn ceph ENOENT')
    expect(value.exitCode).toBe(-1)
  })

  it('ops-access absent: clean error, shell untouched', async () => {
    const h = setup({ withOpsAccess: false })
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    expect(value.error).toContain('ops-access service unavailable')
    expect(value.exitCode).toBe(-1)
    expect(h.calls.shellRun).toBe(0)
  })

  it('render is a pure function of (args, value)', async () => {
    const h = setup()
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    const a = h.renderCeph({ cluster: 'prod', command: 'health' }, value)
    const b = h.renderCeph({ cluster: 'prod', command: 'health' }, value)
    expect(a).toBe(b)
    expect(a).toContain('$ ceph --conf="/etc/ceph/prod.conf" --keyring="/etc/ceph/prod.keyring" health')
    expect(a).toContain('HEALTH_OK')
    // non-zero exit surfaces the exit code line
    const err = h.renderCeph({}, { exitCode: 1, stdout: '', stderr: 'boom', command: 'ceph x' })
    expect(err).toContain('[stderr]')
    expect(err).toContain('[exit code: 1]')
  })
})
