import { assessK8sTier, provider } from '../src/index.ts'
/**
 * Unit spec for ops-access-k8s: schema accept/reject, `~` expansion in
 * process, and registration/disposal through a mock opsAccess context.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Export shape ─────────────────────────────────────────────────────────────

describe('export shape', () => {
  it('is a function plugin: named exports, no default', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('ops-access-k8s')
    expect(plugin.inject).toEqual([])
    expect(typeof plugin.Config).toBe('function')
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.provider.kind).toBe('k8s')
  })

  it('./invariant subpath is a companion plugin: named exports, no default', async () => {
    const invariant = await import('../src/invariant.ts')
    expect('default' in invariant).toBe(false)
    expect(invariant.name).toBe('ops-access-k8s-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(typeof invariant.apply).toBe('function')
  })

  it('./types subpath is types-only: no runtime exports', async () => {
    const types = await import('../src/types.ts')
    expect(Object.keys(types)).toEqual([])
  })
})

// ── Schema ───────────────────────────────────────────────────────────────────

describe('entry schema', () => {
  it('accepts a valid entry', () => {
    expect(plugin.entrySchema.safeParse({ kubeconfig: '~/.kube/prod.yaml' }).success).toBe(true)
  })

  it('rejects a missing or non-string kubeconfig', () => {
    expect(plugin.entrySchema.safeParse({}).success).toBe(false)
    expect(plugin.entrySchema.safeParse({ kubeconfig: 42 }).success).toBe(false)
  })
})

// ── process ──────────────────────────────────────────────────────────────────

describe('process', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it('expands ~ in kubeconfig and outputs kubeconfigPath', () => {
    process.env.HOME = '/home/tester'
    const fields = plugin.provider.process!({ kubeconfig: '~/.kube/prod.yaml' }, 'prod')
    expect(fields).toEqual({ kubeconfigPath: '/home/tester/.kube/prod.yaml' })
  })

  it('leaves absolute paths untouched', () => {
    const fields = plugin.provider.process!({ kubeconfig: '/etc/kube/prod.yaml' }, 'prod')
    expect(fields).toEqual({ kubeconfigPath: '/etc/kube/prod.yaml' })
  })
})

// ── Registration ─────────────────────────────────────────────────────────────

/** Mock ctx whose register disposer really removes the provider from the registry. */
function mockCtx() {
  const registered: AccessProvider[] = []
  const effectCleanups: Array<() => void> = []
  const pctx: any = {
    opsAccess: {
      register: (p: AccessProvider) => {
        registered.push(p)
        return () => {
          const i = registered.indexOf(p)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
    effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
  }
  let injectedDeps: string[] = []
  const ctx: any = {
    inject: (deps: string[], cb: (c: any) => void) => { injectedDeps = deps; cb(pctx) },
  }
  return { ctx, registered, effectCleanups, get injectedDeps() { return injectedDeps } }
}

describe('apply', () => {
  it('defers through ctx.inject and registers once opsAccess arrives', () => {
    const m = mockCtx()
    plugin.apply(m.ctx, { probeTimeoutMs: 10000, probeNamespace: 'default' })
    expect(m.injectedDeps).toEqual(['opsAccess'])
    expect(m.registered).toHaveLength(1)
    expect(m.registered[0].kind).toBe(plugin.provider.kind)
    expect(m.effectCleanups).toHaveLength(1)
  })

  it('HMR unload: running the effect disposers removes the provider from the registry', () => {
    const { ctx, registered, effectCleanups } = mockCtx()

    plugin.apply(ctx, { probeTimeoutMs: 10000, probeNamespace: 'default' })
    expect(registered.map((p) => p.kind)).toEqual(['k8s'])

    for (const dispose of effectCleanups) dispose()
    expect(registered).toEqual([])
  })
})

// fieldsDoc feeds ops-access help() — the agent-facing registry doc.
it('carries fieldsDoc for help()', () => {
  expect(typeof plugin.provider.fieldsDoc).toBe('string')
  expect(plugin.provider.fieldsDoc!.length).toBeGreaterThan(0)
})

// derivationDoc feeds help() — the ro self-registration recipe.
it('carries a derivationDoc naming convention for help()', () => {
  expect(plugin.provider.derivationDoc).toContain('<id>-ro')
  expect(plugin.provider.derivationDoc).toContain('register_access')
})

// ── validateContent (save-time paste guard) ──────────────────────────────────

describe('validateContent', () => {
  const VALID = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: prod',
    '  cluster:',
    '    server: https://10.0.0.1:6443',
    'contexts:',
    '- name: prod',
    '  context:',
    '    cluster: prod',
    '    user: admin',
    'current-context: prod',
    'users:',
    '- name: admin',
    '  user:',
    '    token: abc',
    '',
  ].join('\n')

  it('accepts a full kubeconfig', () => {
    expect(plugin.provider.validateContent?.('kubeconfig', VALID)).toBeNull()
  })

  it('rejects non-YAML garbage', () => {
    expect(plugin.provider.validateContent?.('kubeconfig', '}{][')).toMatch(/not valid YAML/)
  })

  it('rejects YAML without clusters/contexts/users', () => {
    expect(plugin.provider.validateContent?.('kubeconfig', 'foo: bar\n')).toMatch(/no clusters defined/)
    expect(plugin.provider.validateContent?.('kubeconfig', 'clusters: []\ncontexts: []\nusers: []\n')).toMatch(/no clusters defined/)
  })

  it('ignores non-file fields', () => {
    expect(plugin.provider.validateContent?.('note', 'anything')).toBeNull()
  })
})

describe('validateContent current-context', () => {
  const base = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: chaos',
    '  cluster:',
    '    server: https://10.0.0.1:6443',
    'contexts:',
    '- name: chaos',
    '  context:',
    '    cluster: chaos',
    '    user: chaos',
    'users:',
    '- name: chaos',
    '  user:',
    '    token: abc',
  ]

  it('accepts when current-context names a defined context', () => {
    const content = [...base, 'current-context: chaos', ''].join('\n')
    expect(plugin.provider.validateContent?.('kubeconfig', content)).toBeNull()
  })

  it('rejects a stale current-context (the incident case: rw kubeconfig pointing at a nonexistent context)', () => {
    const content = [...base, 'current-context: kubernetes-admin@kubernetes', ''].join('\n')
    expect(plugin.provider.validateContent?.('kubeconfig', content))
      .toMatch(/current-context "kubernetes-admin@kubernetes" does not match any defined context \(defined: chaos\)/)
  })

  it('rejects a missing current-context (ops tools never pass --context)', () => {
    const content = [...base, ''].join('\n')
    expect(plugin.provider.validateContent?.('kubeconfig', content))
      .toMatch(/no current-context.*Defined contexts: chaos/)
  })

  it('derivationDoc covers --raw CA extraction, naming, current-context, and write-denial verification', () => {
    const d = plugin.provider.derivationDoc ?? ''
    expect(d).toContain('--raw')
    expect(d).toContain('current-context')
    expect(d).toContain('forbidden')
  })
})

// ── capability probe (ticket 10) ─────────────────────────────────────────────

describe('capability probe', () => {
  it('ro verifies when reading works and writing is denied', () => {
    expect(assessK8sTier(true, false, 'ro')).toEqual({ status: 'verified' })
  })
  it('ro mismatches when write is allowed — an over-privileged credential in the ro slot', () => {
    const r = assessK8sTier(true, true, 'ro')
    expect(r.status).toBe('mismatch')
    expect(r.detail).toContain('ro slot')
  })
  it('ro mismatches when the credential cannot even read', () => {
    const r = assessK8sTier(false, false, 'ro')
    expect(r.status).toBe('mismatch')
    expect(r.detail).toContain('cannot even read')
  })
  it('rw verifies on read+write; mismatches with the can-i summary otherwise', () => {
    expect(assessK8sTier(true, true, 'rw')).toEqual({ status: 'verified' })
    const r = assessK8sTier(true, false, 'rw')
    expect(r.status).toBe('mismatch')
    expect(r.detail).toContain('create deployments=no')
  })
  it('the real probe degrades to unverifiable when kubectl cannot reach the cluster', async () => {
    const res = await provider.probe!({ kubeconfigPath: '/nonexistent/kubeconfig' }, 'ro')
    expect(res.status).toBe('unverifiable')
    expect(JSON.stringify(res)).not.toContain('/nonexistent')
  }, 20000)
})

describe('probe facets (review fix)', () => {
  it('facets annotate a verified result without gating it', () => {
    const r = assessK8sTier(true, false, 'ro', { servicesProxy: true, podsExec: false })
    expect(r.status).toBe('verified')
    expect(r.detail).toBe('facets: services/proxy=yes, pods/exec=no')
  })
  it('unknown facets are annotated as unknown, never silently dropped', () => {
    const r = assessK8sTier(true, true, 'rw', { servicesProxy: null, podsExec: null })
    expect(r.status).toBe('verified')
    expect(r.detail).toBe('facets: services/proxy=unknown, pods/exec=unknown')
  })
  it('facets ride along on mismatches too', () => {
    const r = assessK8sTier(true, true, 'ro', { servicesProxy: false, podsExec: true })
    expect(r.status).toBe('mismatch')
    expect(r.detail).toContain('pods/exec=yes')
  })
  it('no facets argument keeps the bare verified shape (backwards compatible)', () => {
    expect(assessK8sTier(true, false, 'ro')).toEqual({ status: 'verified' })
  })
})
