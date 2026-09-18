/**
 * Cross-version read of an Agent session's append-only event log.
 *
 * The Agent always exposes its `Session`, but HOW to read the log changed:
 * dsh ≤0.1.1 had a public `get events()`; dsh ≥0.1.2 replaced it with
 * `snapshotEvents()` / `eventAt()` (perf: separate indexed and snapshot log
 * reads, commit 5660f44d29). Reading `session.events` against a newer dsh
 * returns `undefined` — no throw, no log line — so every consumer silently
 * degrades. That is exactly how the trace reminders stopped firing in the
 * 0.1.5-rc.2 test instance (2026-09-16): `buildReminderContext` returned null
 * on every pre-step, so `trace:idle` / `trace:stale-step` / `trace:nesting`
 * never ran.
 *
 * This module is the single home for that read. Both consumers (the reminder
 * context builder and the tool's `currentTurn`) go through it, so the
 * compatibility decision cannot drift between them.
 *
 * @module @elinpf/dsh-ops-tool-trace/session-log
 */

/** The subset of a session event the trace code reads. */
export interface SessionEventLike {
  type: string
  data?: { name?: string, turn?: number, step?: number }
}

/** The session surface the trace code depends on, in both dsh shapes. */
export interface SessionLike {
  id?: string
  /** Legacy accessor, removed in dsh 0.1.2-alpha.4. */
  events?: readonly SessionEventLike[]
  /** Canonical accessor since dsh 0.1.2 (returns a frozen snapshot). */
  snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEventLike[]
}

/**
 * Read one session's event log through whichever accessor the running dsh
 * provides. Returns `undefined` when the session is absent or exposes neither
 * accessor (a caller should treat that as "no log to judge from", never as an
 * empty history).
 */
export function readSessionEvents(session: unknown): readonly SessionEventLike[] | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const s = session as SessionLike
  if (typeof s.snapshotEvents === 'function') {
    try {
      return s.snapshotEvents()
    } catch {
      // Fall through to the legacy accessor rather than losing the log.
    }
  }
  return s.events
}
