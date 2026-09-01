import { describe, expect, it } from 'vitest'
import * as mod from '../src/index.ts'
import * as invariantMod from '../src/invariant.ts'
import * as typesMod from '../src/types.ts'
import { setup, DEFAULT_PROFILE } from './harness.ts'

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect(mod.name).toBe('ops-tool-ceph')
    expect(mod.inject).toEqual(['shell', 'tools'])
    expect(mod.Config).toBeDefined()
    expect(typeof mod.apply).toBe('function')
    expect((mod as any).default).toBeUndefined()
  })

  it('./invariant entry is a function plugin: named exports, no default', () => {
    expect(invariantMod.name).toBe('ops-ceph-invariant')
    expect(invariantMod.inject).toEqual(['invariants'])
    expect(typeof invariantMod.apply).toBe('function')
    expect((invariantMod as any).default).toBeUndefined()
  })

  it('./types entry carries zero runtime code', () => {
    expect(Object.keys(typesMod)).toHaveLength(0)
  })
})

describe('HMR unload', () => {
  it('running every effect disposer unregisters the ceph tool', () => {
    const h = setup()
    expect(h.tools.some((t) => t.name === 'ceph')).toBe(true)
    expect(h.effectCleanups.length).toBeGreaterThan(0)
    for (const dispose of h.effectCleanups) dispose()
    expect(h.tools.some((t) => t.name === 'ceph')).toBe(false)
    expect(h.tools).toHaveLength(0)
  })
})

describe('ceph', () => {
  it('happy path: resolves the profile, assembles the command, maps the result', async () => {
    const h = setup()
    const { value, exec } = await h.runCeph({ cluster: 'prod', command: 'health detail' })
    expect(h.calls.resolve).toBe(1)
    expect(h.calls.shellResolve).toBe(1)
    expect(h.calls.shellRun).toBe(1)
    expect(value.command).toBe('ceph --conf=<prod@ro:conf> --keyring=<prod@ro:keyring> health detail')
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('HEALTH_OK\n')
    // 30s timeout and the exec AbortSignal pass through to the shell service
    expect(h.shellRequests[0].timeoutMs).toBe(30000)
    expect(h.shellRequests[0].signal).toBe(exec.signal)
  })

  it('rbd command: first word selects the rbd binary, injected flags unchanged', async () => {
    const h = setup()
    const { value } = await h.runCeph({ cluster: 'prod', command: 'rbd ls -p rbd-pool' })
    expect(value.command).toBe('rbd --conf=<prod@ro:conf> --keyring=<prod@ro:keyring> ls -p rbd-pool')
  })

  it('rados command: first word selects the rados binary', async () => {
    const h = setup()
    const { value } = await h.runCeph({ cluster: 'prod', command: 'rados df' })
    expect(value.command).toBe('rados --conf=<prod@ro:conf> --keyring=<prod@ro:keyring> df')
  })

  it('an explicit ceph prefix is stripped to the same ceph invocation', async () => {
    const h = setup()
    const { value } = await h.runCeph({ cluster: 'prod', command: 'ceph osd tree' })
    expect(value.command).toBe('ceph --conf=<prod@ro:conf> --keyring=<prod@ro:keyring> osd tree')
  })

  it('a binary this tool does not wrap is rejected with a boundary message, shell untouched', async () => {
    const h = setup()
    const { value } = await h.runCeph({ cluster: 'prod', command: 'mount -t cephfs :/ /mnt/x' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('runs locally')
    expect(value.error).toContain('ssh tool')
    expect(h.calls.shellRun).toBe(0)
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
        kind: 'ceph', name: 'rook-test', tier: 'ro' as const,
        fields: { conf: '/etc/ceph/rook.conf', keyring: '/etc/ceph/rook.keyring', name: 'client.dsh-test' },
      }),
    })
    const { value } = await h.runCeph({ cluster: 'rook-test', command: 'fsid' })
    // The cephx entity name stays inline (not secret); file paths are tokens.
    expect(value.command).toBe('ceph --conf=<rook-test@ro:conf> --keyring=<rook-test@ro:keyring> --name client.dsh-test fsid')
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

  it('filters known keyring noise lines from stderr, keeps real warnings', async () => {
    const noise = [
      '2026-08-20T10:00:00.123+0000 7f9c1a2b3640 -1 auth: unable to find a keyring on /etc/ceph/ceph.client.dsh.keyring,/etc/ceph/ceph.keyring,/etc/ceph/keyring,/etc/ceph/keyring.bin: (2) No such file or directory',
      '2026-08-20T10:00:00.124+0000 7f9c1a2b3640 -1 auth: no keyring found at /etc/ceph/ceph.client.dsh.keyring, disabling cephx',
    ].join('\n')
    const h = setup({
      runImpl: async () => ({
        exitCode: 0,
        stdoutText: 'HEALTH_OK\n',
        stderrText: `${noise}\npool scbench creating\n`,
      }),
    })
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    expect(value.stderr).toBe('pool scbench creating\n')
    expect(value.stdout).toBe('HEALTH_OK\n')
  })

  it('stderr that is only keyring noise becomes empty', async () => {
    const h = setup({
      runImpl: async () => ({
        exitCode: 0,
        stdoutText: 'HEALTH_OK\n',
        stderrText: 'no keyring found at /etc/ceph/ceph.keyring, disabling cephx\n',
      }),
    })
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    expect(value.stderr).toBe('')
  })

  it('non-matching stderr (including other "keyring" mentions) passes through verbatim', async () => {
    const stderrText = 'Error EINVAL: keyring file is empty\nunable to find a keyring on unexpected shape\n'
    const h = setup({
      runImpl: async () => ({ exitCode: 1, stdoutText: '', stderrText }),
    })
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    expect(value.stderr).toBe(stderrText)
  })

  it('render is a pure function of (args, value)', async () => {
    const h = setup()
    const { value } = await h.runCeph({ cluster: 'prod', command: 'health' })
    const a = h.renderCeph({ cluster: 'prod', command: 'health' }, value)
    const b = h.renderCeph({ cluster: 'prod', command: 'health' }, value)
    expect(a).toBe(b)
    expect(a).toContain('$ ceph --conf=<prod@ro:conf> --keyring=<prod@ro:keyring> health')
    expect(a).toContain('HEALTH_OK')
    // non-zero exit surfaces the exit code line
    const err = h.renderCeph({}, { exitCode: 1, stdout: '', stderr: 'boom', command: 'ceph x' })
    expect(err).toContain('[stderr]')
    expect(err).toContain('[exit code: 1]')
  })
})
