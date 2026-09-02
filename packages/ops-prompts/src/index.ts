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
 * @module @elinpf/dsh-ops-prompts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createBundledSkillsProvider } from './skills.js'
// The Config interface is imported under an alias: re-exporting the same name
// from types.ts would collide with the exported const Config below (TS2323).
import type { Config as ConfigShape, MethodologyEntry, OpsPromptsHandle, ReminderEntry } from './types.js'
export * from './skills.js'
export type { MethodologyEntry, OpsPromptsHandle, ReminderEntry } from './types.js'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-prompts'

export const inject = ['systemPrompt']

// ── Config ───────────────────────────────────────────────────────────────────

// The Config interface lives in types.ts; only the runtime schema stays here.
// A local type alias (not a re-export) keeps the familiar interface+const pair.
export type Config = ConfigShape
export const Config: z<Config> = z.object({
  reminderEnabled: z.boolean().default(true),
})

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

  // Bundled ops skills: ship this package's skills/ directory into dsh's
  // native skill subsystem (catalog via candidates, bodies pulled on demand
  // through the `skill` tool). The skills registry lives in the host
  // composition — resolve with the usual get-first / inject-fallback race
  // discipline, and tolerate its absence (this package then works as a pure
  // prompt channel).
  const registerBundledSkills = (rctx: Context, registry: SkillRegistry): void => {
    rctx.effect(() => registry.registerProvider(() =>
      createBundledSkillsProvider(undefined, m => rctx.logger('ops-prompts').warn(m))))
  }
  const immediateSkills = ctx.get('skills')
  if (immediateSkills !== undefined) {
    registerBundledSkills(ctx, immediateSkills)
  } else {
    ctx.inject(['skills'], (pctx: Context) => {
      registerBundledSkills(pctx, pctx.skills)
    })
  }

  // System prompt section that renders all registered methodology entries.
  // Re-evaluated at each prompt assembly. systemPrompt is a REQUIRED inject:
  // an absent service pends the fiber and apply never runs, so read it as a
  // declared dependency — a ctx.get fallback branch would be dead code.
  // The section disposer MUST go through ctx.effect: the service returns a
  // disposer that fiber disposal/HMR would otherwise never run (leak).
  const systemPrompt = (ctx as unknown as {
    systemPrompt: { section(def: { name: string, order: number, text: () => string }): () => void }
  }).systemPrompt
  ctx.effect(() => systemPrompt.section({
    name: 'ops:methodology',
    order: 250,
    text: () => {
      const entries = [...methodologies.values()].sort((a, b) => a.order - b.order)
      return entries.map((e) => e.text).join('\n\n')
    },
  }))

  // agent/pre-step listener: evaluate all registered reminder rules.
  // Non-null results are delivered through agent.inject — the message goes
  // through the durable inbox splice (agent/inbox/spliced), so the reminder
  // is reconstructable from the session log (model-visible ⟺ logged) and is
  // claimed at the next step boundary.
  if (config.reminderEnabled) {
    ;(ctx.on as any)('agent/pre-step', async (payload: any, next: any) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision

      const agent = payload?.agent
      if (!agent || typeof agent.inject !== 'function') return decision

      const results: string[] = []
      for (const reminder of reminders.values()) {
        const text = reminder.check(agent)
        if (text !== null) results.push(text)
      }
      if (results.length === 0) return decision

      agent.inject(createUserMessage({
        content: [{ type: 'text', text: results.join('\n') }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'ops reminder' },
      }))
      return decision
    }, { prepend: true })
  }
}
