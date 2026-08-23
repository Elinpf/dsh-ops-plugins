/**
 * Test harness for ops-trace: mounts the plugin against a minimal mock
 * context and captures every registration surface (tool, projection,
 * methodology, reminders) so specs can drive the real plugin code.
 *
 * The module-level sessionForests map is shared across tests in one process,
 * so every setup() gets a unique session id to isolate state.
 */

import { apply } from '../src/index.ts'
import type { ForestState, TraceResult } from '../src/types.ts'

export interface CapturedOpsPrompts {
  methodologies: Array<{ name: string, order: number, text: string }>
  reminders: Map<string, (agent: unknown) => string | null>
}

let sessionCounter = 0

export function setup(opts: {
  /** Pre-folded projection state, simulating the dsh runtime where the
   *  tool/call event is appended (and folded) BEFORE execute runs. */
  projectionState?: ForestState | null
  /** Whether the opsPrompts service resolves (false = host-plane mount). */
  withOpsPrompts?: boolean
} = {}) {
  const sessionId = `test-${++sessionCounter}`
  const tools: any[] = []
  const toolDisposers: Array<() => void> = []
  const effectCleanups: Array<() => void> = []
  const registeredProjections: any[] = []
  const opsPrompts: CapturedOpsPrompts = { methodologies: [], reminders: new Map() }

  const ctx: any = {
    inject: (deps: string[], cb: (c: any) => void) => {
      if (deps.includes('sessionProjections')) {
        cb({
          sessionProjections: {
            register: (def: any) => {
              registeredProjections.push(def)
              return () => {}
            },
            snapshot: () => ({ values: { trace: opts.projectionState ?? null } }),
          },
        })
      }
      if (deps.includes('opsPrompts') && opts.withOpsPrompts !== false) {
        cb({
          opsPrompts: {
            registerMethodology: (m: any) => {
              opsPrompts.methodologies.push(m)
              return () => {}
            },
            registerReminder: (r: any) => {
              opsPrompts.reminders.set(r.name, r.check)
              return () => {}
            },
          },
        })
      }
    },
    effect: (fn: () => () => void) => { effectCleanups.push(fn()) },
    tools: {
      register: (t: any) => {
        tools.push(t)
        const d = () => {}
        toolDisposers.push(d)
        return d
      },
    },
    get: (_name: string) => undefined,
  }

  apply(ctx, {})

  const tool = tools[0]
  /** exec context; `events` drives currentTurn (turn/start) — empty means turn 0. */
  const exec = (events: any[] = []) => ({
    agent: { id: 'agent-1', session: { id: sessionId, events } },
  })
  const run = (args: Record<string, unknown>, events: any[] = []): Promise<TraceResult> =>
    tool.execute(args, exec(events))
  const render = (args: Record<string, unknown>, value: TraceResult): string =>
    tool.output.render(args, value)[0].text

  return { tool, run, render, opsPrompts, registeredProjections, effectCleanups, sessionId }
}

/** Minimal agent shape the reminder checks read. */
export function agentWithEvents(events: any[], sessionId = 'reminder-session') {
  return { session: { id: sessionId, events } }
}

export function stepStart(turn: number, step: number) {
  return { type: 'step/start', data: { turn, step } }
}

export function traceCall(args: Record<string, unknown>) {
  return { type: 'tool/call', data: { name: 'trace', arguments: JSON.stringify(args) } }
}
