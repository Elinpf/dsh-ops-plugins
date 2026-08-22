/**
 * Ops prompt orchestration center.
 *
 * Provides a capability (`ctx.get('opsPrompts')`) that other ops plugins use
 * to register methodology prompts (static system prompt sections) and dynamic
 * reminders (evaluated at each agent/pre-step, injected into the conversation
 * flow).
 *
 * It also registers its own core ops methodology prompt and the agent/pre-step
 * listener that evaluates all registered reminder rules.
 *
 * @module @deepseek-ai/dsh-ops-prompts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-prompts'

export const inject = ['systemPrompt']

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  /** Whether dynamic reminders are enabled. */
  reminderEnabled: boolean
}

export const Config: z<Config> = z.object({
  reminderEnabled: z.boolean().default(true),
})

// ── Registration types ───────────────────────────────────────────────────────

/** A registered methodology prompt section. */
export interface MethodologyEntry {
  name: string
  order: number
  text: string
}

/** A registered dynamic reminder rule. */
export interface ReminderEntry {
  name: string
  check: (agent: any) => string | null
}

/** The ops prompt orchestration handle exposed via ctx.get('opsPrompts'). */
export interface OpsPromptsHandle {
  /** Register a static methodology prompt section. Returns a disposer. */
  registerMethodology(opts: MethodologyEntry): () => void
  /** Register a dynamic reminder rule evaluated at each agent/pre-step. Returns a disposer. */
  registerReminder(opts: ReminderEntry): () => void
}

// ── Core ops methodology ─────────────────────────────────────────────────────

const CORE_METHODOLOGY = [
  '## Ops investigation discipline',
  '',
  '### Root cause analysis',
  '- Every conclusion must answer "why". Do not stop at a symptom or intermediate cause.',
  '- Keep asking "why does this happen?" until you reach a physical or infrastructure-level fact',
  '  (e.g. "disk full", "memory exhausted", "network partition").',
  '- "The CSI operation is stuck" is NOT a root cause. "Ceph storage is 99% full, blocking OMAP writes"',
  '  IS a root cause.',
  '',
  '### Verify before concluding',
  '- Do not mark a step done with an unverified hypothesis.',
  '- If you claim "X is caused by Y", verify Y before completing the step.',
  '- `done` means the investigation of this step is complete, NOT that the conclusion is final.',
  '  Use `reopen` when a completed step\'s conclusion turns out to be wrong or incomplete.',
  '',
  '### Structure your investigation',
  '- When you find something new, add a step — do not accumulate findings in a single node.',
  '- Use `link` to record causal edges: "this symptom is caused by that root cause".',
  '- Use `abandon` for dead ends AND for steps no longer relevant due to changed circumstances.',
].join('\n')

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const methodologies = new Map<string, MethodologyEntry>()
  const reminders = new Map<string, ReminderEntry>()

  // Expose the handle so other plugins can register through ctx.get('opsPrompts')
  const handle: OpsPromptsHandle = {
    registerMethodology(opts: MethodologyEntry): () => void {
      methodologies.set(opts.name, opts)
      return () => { methodologies.delete(opts.name) }
    },
    registerReminder(opts: ReminderEntry): () => void {
      reminders.set(opts.name, opts)
      return () => { reminders.delete(opts.name) }
    },
  }
  ctx.provide('opsPrompts', handle)

  // Register core ops methodology as the first entry
  handle.registerMethodology({
    name: 'ops:core',
    order: 250,
    text: CORE_METHODOLOGY,
  })

  // System prompt section that renders all registered methodology entries.
  // Re-evaluated at each prompt assembly.
  const systemPrompt = ctx.get('systemPrompt') as any | undefined
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'ops:methodology',
      order: 250,
      text: () => {
        const entries = [...methodologies.values()].sort((a, b) => a.order - b.order)
        return entries.map((e) => e.text).join('\n\n')
      },
    })
  }

  // agent/pre-step listener: evaluate all registered reminder rules.
  // Injects non-null results as a single plugin-sourced notice message.
  if (config.reminderEnabled) {
    ;(ctx.on as any)('agent/pre-step', async (payload: any, next: any) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision

      const agent = payload?.agent
      if (!agent) return decision

      const results: string[] = []
      for (const reminder of reminders.values()) {
        const text = reminder.check(agent)
        if (text !== null) results.push(text)
      }
      if (results.length === 0) return decision

      const text = results.join('\n')
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'ops reminder' },
          }),
        ],
      }
    }, { prepend: true })
  }
}
