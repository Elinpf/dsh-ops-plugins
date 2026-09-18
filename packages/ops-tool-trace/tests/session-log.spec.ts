/**
 * session-log spec: the cross-version event-log read seam.
 *
 * dsh ≤0.1.1 exposed `session.events` (a getter); dsh ≥0.1.2 replaced it with
 * `snapshotEvents()`. Reading the removed getter returns undefined, which
 * silently disabled every trace reminder (2026-09-16). These tests pin both
 * supported shapes so the seam cannot regress to one of them.
 */

import { describe, it, expect } from 'vitest'
import { readSessionEvents } from '../src/session-log.ts'

const EVENTS = [
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'tool/call', data: { name: 'trace' } },
]

describe('readSessionEvents', () => {
  it('prefers snapshotEvents() when the session exposes it (dsh ≥0.1.2)', () => {
    const session = { id: 's1', snapshotEvents: () => EVENTS }
    expect(readSessionEvents(session)).toBe(EVENTS)
  })

  it('prefers snapshotEvents() even when a legacy events field is also present', () => {
    const legacy = [{ type: 'turn/start', data: { turn: 9 } }]
    const session = { id: 's1', events: legacy, snapshotEvents: () => EVENTS }
    expect(readSessionEvents(session)).toBe(EVENTS)
  })

  it('falls back to the legacy `events` getter (dsh ≤0.1.1)', () => {
    expect(readSessionEvents({ id: 's1', events: EVENTS })).toBe(EVENTS)
  })

  it('falls back to `events` when snapshotEvents() throws', () => {
    const session = {
      id: 's1',
      events: EVENTS,
      snapshotEvents: () => { throw new Error('nope') },
    }
    expect(readSessionEvents(session)).toBe(EVENTS)
  })

  it('returns undefined without a session, a log, or either accessor', () => {
    expect(readSessionEvents(undefined)).toBeUndefined()
    expect(readSessionEvents(null)).toBeUndefined()
    expect(readSessionEvents({ id: 's1' })).toBeUndefined()
    expect(readSessionEvents('not a session')).toBeUndefined()
  })
})
