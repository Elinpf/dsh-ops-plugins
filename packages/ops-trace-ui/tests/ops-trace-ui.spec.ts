/**
 * ops-trace-ui spec: both entries' export shape, the host half registering
 * the shared `trace` projection exactly once (and nothing else — no tools,
 * no prompt sections), the client half's dock slot entry, and HMR unload:
 * running every fiber disposer removes each registration surface.
 *
 * Mock fidelity note: the real registries (sessionProjections, slots)
 * self-bind each registration's disposer to the calling fiber, so the
 * plugin code deliberately drops the returned disposers. The mocks mirror
 * that by collecting the disposers into effectCleanups — running them
 * simulates fiber disposal (HMR unload).
 */

import { describe, expect, it, vi } from 'vitest'

// The icon package's entry transitively imports katex CSS, which node cannot
// load — the dock only needs three icon components, so stub the module. The
// real components are exercised in the browser, not here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChecklistOutline14: () => null,
  IconChevronDownOutline14: () => null,
  IconChevronUpOutline14: () => null,
}))

import * as host from '../src/index.ts'
import * as client from '../src/client.ts'
import * as invariant from '../src/invariant.ts'
import { traceProjection } from '@elinpf/dsh-ops-tool-trace'

// ── Host half ────────────────────────────────────────────────────────────────

function setupHost() {
  const registeredProjections: any[] = []
  const effectCleanups: Array<() => void> = []
  const ctx: any = {
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.includes('sessionProjections')) {
        cb({
          sessionProjections: {
            register: (def: any) => {
              registeredProjections.push(def)
              // Real disposer: removes the definition from the registry.
              const dispose = () => {
                const i = registeredProjections.indexOf(def)
                if (i >= 0) registeredProjections.splice(i, 1)
              }
              // The real registry rides the calling fiber — mirror that.
              effectCleanups.push(dispose)
              return dispose
            },
          },
        })
      }
    },
  }
  host.apply(ctx, {})
  return { registeredProjections, effectCleanups }
}

describe('host half', () => {
  it('exports the plugin identity (function-plugin shape, no default export)', () => {
    expect('default' in host).toBe(false)
    expect(host.name).toBe('ops-trace-ui')
    expect(host.inject).toEqual([])
    expect(host.Config).toBeDefined()
    expect(typeof host.apply).toBe('function')
  })

  it('registers the shared trace projection, verbatim from ops-tool-trace', () => {
    const { registeredProjections } = setupHost()
    expect(registeredProjections).toHaveLength(1)
    // Reference identity, not shape equality: the definition has exactly one
    // home, so key/schema/fold/stateVersion can never drift between packages.
    expect(registeredProjections[0]).toBe(traceProjection)
    expect(registeredProjections[0].key).toBe('trace')
    expect(registeredProjections[0].stateVersion).toBe(traceProjection.stateVersion)
  })

  it('the registered fold reconstructs a tree from tool/call events', () => {
    const { registeredProjections } = setupHost()
    const def = registeredProjections[0]
    let state = def.init()
    expect(state).toBeNull()
    state = def.apply(state, {
      type: 'tool/call',
      data: { name: 'trace', turn: 1, arguments: JSON.stringify({ action: 'create_tree', goal_title: 'G' }) },
    })
    expect(state.trees).toHaveLength(1)
    expect(state.trees[0].nodes[0]).toMatchObject({ id: 'goal', title: 'G', status: 'goal' })
    // Non-trace events and other tools fold to a no-op.
    expect(def.apply(state, { type: 'tool/call', data: { name: 'bash' } })).toBe(state)
    expect(def.apply(state, { type: 'turn/start', data: {} })).toBe(state)
  })

  it('registers no tools and no prompt sections', () => {
    const ctx: any = {
      inject: (_deps: string[], _cb: (c: any) => void) => {},
      tools: { register: () => { throw new Error('must not register tools') } },
    }
    expect(() => host.apply(ctx, {})).not.toThrow()
  })

  it('HMR unload: running the fiber disposers removes the projection registration', () => {
    const { registeredProjections, effectCleanups } = setupHost()
    expect(registeredProjections).toHaveLength(1)
    expect(effectCleanups).toHaveLength(1)
    for (const cleanup of effectCleanups) cleanup()
    expect(registeredProjections).toHaveLength(0)
  })
})

// ── Client half ──────────────────────────────────────────────────────────────

function setupClient() {
  const dockEntries: any[] = []
  const effectCleanups: Array<() => void> = []
  const ctx: any = {
    slots: {
      // slots.inject runs the factory on the slot fiber and rides the
      // returned disposer on it — mirror by collecting it.
      inject: (_slot: string, factory: () => () => void) => {
        const dispose = factory()
        effectCleanups.push(dispose)
        return dispose
      },
      register: (opts: any, component: any) => {
        const entry = { ...opts, component }
        dockEntries.push(entry)
        // Real disposer: removes the entry from the slot registry.
        return () => {
          const i = dockEntries.indexOf(entry)
          if (i >= 0) dockEntries.splice(i, 1)
        }
      },
    },
  }
  client.apply(ctx)
  return { dockEntries, effectCleanups }
}

describe('client half', () => {
  it('exports the plugin identity (function-plugin shape, no default export)', () => {
    expect('default' in client).toBe(false)
    expect(client.name).toBe('ops-trace-client')
    expect(client.inject).toEqual(['slots'])
    expect(typeof client.apply).toBe('function')
  })

  it('registers one conversation.input.dock entry (id=ops-tree)', () => {
    const { dockEntries } = setupClient()
    expect(dockEntries).toHaveLength(1)
    expect(dockEntries[0].name).toBe('conversation.input.dock')
    expect(dockEntries[0].id).toBe('ops-tree')
    expect(dockEntries[0].order).toBe(10)
    expect(typeof dockEntries[0].component).toBe('function')
  })

  it('HMR unload: running the fiber disposers removes the dock slot entry', () => {
    const { dockEntries, effectCleanups } = setupClient()
    expect(dockEntries).toHaveLength(1)
    expect(effectCleanups).toHaveLength(1)
    for (const cleanup of effectCleanups) cleanup()
    expect(dockEntries).toHaveLength(0)
  })
})

// ── Invariant companion ──────────────────────────────────────────────────────

describe('invariant companion', () => {
  it('is a function plugin that reserves package ownership, with no runtime invariant', async () => {
    expect('default' in invariant).toBe(false)
    expect(invariant.name).toBe('ops-trace-ui-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    const registered: Array<{ pkg: string, install: () => void }> = []
    await invariant.apply({
      invariants: { register: (pkg: string, install: () => void) => { registered.push({ pkg, install }) } },
    })
    expect(registered).toHaveLength(1)
    expect(registered[0].pkg).toBe('@elinpf/dsh-ops-trace-ui')
    // The install is intentionally a no-op — the reason lives in its JSDoc.
    expect(() => registered[0].install()).not.toThrow()
  })
})
