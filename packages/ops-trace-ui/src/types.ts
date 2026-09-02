/**
 * Type definitions for ops-trace-ui.
 *
 * Types only — no runtime values live here. The client half imports the
 * dock's UI-state shape from here; the host entry re-exports both so the
 * package has one types home (also reachable via the ./types subpath).
 *
 * @module @elinpf/dsh-ops-trace-ui/types
 */

/**
 * Per-session panel UI state. The dock unmounts when switching
 * conversations, so React state resets on every switch-back — the two user
 * choices live in a module-level map keyed by session to survive unmount.
 * `activeIndex` null = follow the active tree (auto), set = user-pinned.
 */
export interface DockUiState {
  collapsed: boolean
  activeIndex: number | null
}

/**
 * Props the dock slot runtime hands to the trace panel component. Both are
 * optional: the panel degrades to rendering nothing when the projection
 * registry or the session handle is absent.
 */
export interface TraceDockProps {
  /** Projection read face; throws when the projection registry is absent. */
  useProjection?: (key: string) => unknown | undefined
  /** The session the dock renders for. */
  session?: { sessionId?: string }
}
