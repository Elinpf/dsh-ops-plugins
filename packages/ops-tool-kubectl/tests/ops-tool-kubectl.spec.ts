/**
 * Unit spec for ops-tool-kubectl: drives the real plugin through the mock
 * context, covering the kubectl happy path (command assembly, timeout, signal
 * passthrough), resolve and shell failure fallbacks, render purity, the
 * list_access grouping with its no-fields guarantee, and the export shape.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { AccessProfile } from '@deepseek-ai/dsh-ops-access'
import { setup, DEFAULT_KUBECONFIG, DEFAULT_PROFILE } from './harness.ts'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-tool-kubectl')
    expect(plugin.inject).toEqual(['shell', 'tools'])
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
  })
})

// ── kubectl ──────────────────────────────────────────────────────────────────

describe('kubectl', () => {
  it('happy path: resolves the profile, assembles the command, maps the result', async () => {
    const h = setup()
    const { value, exec } = await h.runKubectl({ cluster: 'prod', command: 'get pods -n default' })

    expect(h.calls.resolve).toBe(1)
    expect(h.calls.shellResolve).toBe(1)
    expect(h.calls.shellRun).toBe(1)

    const request = h.shellRequests[0]
    expect(request.command).toBe(`kubectl --kubeconfig="${DEFAULT_KUBECONFIG}" get pods -n default`)
    expect(request.timeoutMs).toBe(30000)
    expect(request.signal).toBe(exec.signal)

    expect(value).toEqual({
      exitCode: 0,
      stdout: 'NAME\tREADY\npod-a\t1/1\n',
      stderr: '',
      command: `kubectl --kubeconfig="${DEFAULT_KUBECONFIG}" get pods -n default`,
    })
  })

  it('normalizes a null exitCode (signal death) to -1', async () => {
    const h = setup({ runImpl: async () => ({ exitCode: null, stdoutText: '', stderrText: 'killed' }) })
    const { value } = await h.runKubectl({ cluster: 'prod', command: 'get pods' })
    expect(value.exitCode).toBe(-1)
    expect(value.error).toBeUndefined()
  })

  it('unknown cluster name: resolve error passes through with available names, shell untouched', async () => {
    const h = setup({
      resolveImpl: async (_kind, name) => {
        throw new Error(`ops-access: no profile "${name}" for kind "k8s" in registry file /home/test/.dsh-ops/access.yaml (available: prod, staging)`)
      },
    })
    const { value } = await h.runKubectl({ cluster: 'nope', command: 'get pods' })

    expect(value.exitCode).toBe(-1)
    expect(value.error).toContain('no profile "nope"')
    expect(value.error).toContain('available: prod, staging')
    expect(value.stderr).toBe(value.error)
    expect(value.stdout).toBe('')
    expect(h.calls.shellResolve).toBe(0)
    expect(h.calls.shellRun).toBe(0)
  })

  it('shell.run throwing falls back to an error result', async () => {
    const h = setup({
      runImpl: async () => { throw new Error('spawn kubectl ENOENT') },
    })
    const { value } = await h.runKubectl({ cluster: 'prod', command: 'get pods' })

    expect(value.exitCode).toBe(-1)
    expect(value.error).toBe('spawn kubectl ENOENT')
    expect(value.stderr).toBe('spawn kubectl ENOENT')
    expect(value.stdout).toBe('')
    expect(value.command).toBe(`kubectl --kubeconfig="${DEFAULT_KUBECONFIG}" get pods`)
  })

  it('render is a pure function of (args, value)', async () => {
    const h = setup()
    const { value } = await h.runKubectl({ cluster: 'prod', command: 'get pods' })
    const args = { cluster: 'prod', command: 'get pods' }

    const callsBefore = { ...h.calls }
    const first = h.renderKubectl(args, value)
    const second = h.renderKubectl(args, value)
    expect(first).toBe(second)
    expect(first).toContain(`$ kubectl --kubeconfig="${DEFAULT_KUBECONFIG}" get pods`)
    // Rendering touched nothing external.
    expect(h.calls).toEqual(callsBefore)

    const errValue = { exitCode: -1, stdout: '', stderr: 'boom', command: '', error: 'boom' }
    expect(h.renderKubectl(args, errValue)).toBe(h.renderKubectl(args, errValue))
    expect(h.renderKubectl(args, errValue)).toBe('[stderr]\nboom\n\n[error] boom\n\n[exit code: -1]')
    expect(h.renderKubectl(args, { exitCode: 0, stdout: '', stderr: '', command: '' })).toBe('(no output)')
    expect(h.calls).toEqual(callsBefore)
  })
})

// ── list_access ──────────────────────────────────────────────────────────────

describe('list_access', () => {
  const profiles: AccessProfile[] = [
    DEFAULT_PROFILE,
    { kind: 'k8s', name: 'staging', environment: 'staging', fields: { kubeconfigPath: '/home/test/.kube/staging.yaml' } },
    { kind: 'ceph', name: 'ceph-main', description: 'ceph 集群', fields: { keyringPath: '/etc/ceph/ceph.client.admin.keyring', monHost: '10.0.0.1' } },
  ]

  it('groups profiles by kind and never leaks fields', async () => {
    const h = setup({ listImpl: async () => profiles })
    const value = await h.runListAccess()

    expect(value.total).toBe(3)
    expect(value.groups.map((g: any) => g.kind)).toEqual(['ceph', 'k8s'])
    const k8s = value.groups.find((g: any) => g.kind === 'k8s')
    expect(k8s.profiles).toEqual([
      { name: 'prod', description: '生产集群', environment: 'prod' },
      { name: 'staging', environment: 'staging' },
    ])

    // No fields key or value anywhere in the structured output.
    const json = JSON.stringify(value)
    expect(json).not.toContain('fields')
    expect(json).not.toContain('kubeconfigPath')
    expect(json).not.toContain('keyringPath')
    expect(json).not.toContain('/home/test')
    expect(json).not.toContain('10.0.0.1')

    // Render is grouped, human-readable, and equally clean.
    const text = h.renderListAccess(value)
    expect(text).toContain('ceph (1):')
    expect(text).toContain('k8s (2):')
    expect(text).toContain('- prod [prod] — 生产集群')
    expect(text).not.toContain('kubeconfig')
    expect(text).not.toContain('/home/test')
    expect(text).not.toContain('10.0.0.1')
    // Pure: same input, same output.
    expect(h.renderListAccess(value)).toBe(text)
  })

  it('empty registry: explicit empty/missing-file message', async () => {
    const h = setup({ listImpl: async () => [] })
    const value = await h.runListAccess()
    expect(value).toEqual({ groups: [], total: 0 })
    expect(h.renderListAccess(value)).toContain('empty or does not exist')
  })
})
