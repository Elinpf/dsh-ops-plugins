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
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.provider.kind).toBe('k8s')
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

describe('apply', () => {
  it('defers through ctx.inject and registers once opsAccess arrives', () => {
    const registered: AccessProvider[] = []
    let disposed = false
    const effectCleanups: Array<() => void> = []
    const pctx: any = {
      opsAccess: {
        register: (p: AccessProvider) => {
          registered.push(p)
          return () => { disposed = true }
        },
      },
      effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    }
    let injectedDeps: string[] = []
    const ctx: any = {
      inject: (deps: string[], cb: (c: any) => void) => { injectedDeps = deps; cb(pctx) },
    }

    plugin.apply(ctx, {})
    expect(injectedDeps).toEqual(['opsAccess'])
    expect(registered).toEqual([plugin.provider])
    expect(effectCleanups).toHaveLength(1)
    effectCleanups[0]()
    expect(disposed).toBe(true)
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
