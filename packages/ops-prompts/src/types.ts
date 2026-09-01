/**
 * Type definitions for the ops-prompts plugin.
 *
 * @module @deepseek-ai/dsh-ops-prompts
 */

// ── Config ───────────────────────────────────────────────────────────────────

// The runtime schema (const Config) lives in index.ts — this file is
// types-only. Config stays available here as the type half of the pair.
export interface Config {
  /** Whether dynamic reminders are enabled. */
  reminderEnabled: boolean
}

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
