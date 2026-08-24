/**
 * ops-trace-ui spec: the host-plane half must register the shared `trace`
 * projection exactly once, and nothing else — no tools, no prompt sections.
 */

import { describe, expect, it } from 'vitest'
import { apply, inject, name, Config } from '../src/index.ts'
import { traceProjection } from '@deepseek-ai/dsh-ops-tool-trace'

function setup() {
  const registeredProjections: any[] = []
  const ctx: any = {
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.includes('sessionProjections')) {
        cb({
          sessionProjections: {
            register: (def: any) => {
              registeredProjections.push(def)
              return () => {}
            },
          },
        })
      }
    },
  }
  apply(ctx, {})
  return { registeredProjections }
}

describe('ops-trace-ui', () => {
  it('exports the plugin identity (function-plugin shape, no default export)', () => {
    expect(name).toBe('ops-trace-ui')
    expect(inject).toEqual([])
    expect(Config).toBeDefined()
  })

  it('registers the shared trace projection, verbatim from ops-tool-trace', () => {
    const { registeredProjections } = setup()
    expect(registeredProjections).toHaveLength(1)
    // Reference identity, not shape equality: the definition has exactly one
    // home, so key/schema/fold/stateVersion can never drift between packages.
    expect(registeredProjections[0]).toBe(traceProjection)
    expect(registeredProjections[0].key).toBe('trace')
    expect(registeredProjections[0].stateVersion).toBe(3)
  })

  it('the registered fold reconstructs a tree from tool/call events', () => {
    const { registeredProjections } = setup()
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
    expect(() => apply(ctx, {})).not.toThrow()
  })
})
