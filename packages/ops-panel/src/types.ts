/**
 * Vocabulary types of the panel seam (ADR-0004). Types only — no runtime
 * code. Both halves import from here: the node half for the command helper,
 * the client half for the registry contract, consumers for both.
 */

/**
 * Props every panel content component receives from the shell. sessionId
 * is the session the slash command ran in (panels are session-scoped);
 * close dismisses the panel (e.g. after a successful submit).
 */
export interface PanelContentProps {
  readonly sessionId: string
  readonly close: () => void
}

/**
 * A panel content renderer, hosted inside the shell card. React-free by
 * design: no repo package compiles against React types (client bundles are
 * esbuild-only, excluded from tsc), so the return type stays structural —
 * the shell hands the component to createElement, consumers return React
 * elements.
 */
export type PanelComponent = (props: PanelContentProps) => unknown

/**
 * One panel registration. The panel identity IS its command name: the
 * node half registers a host slash command of the same name via
 * registerPanelCommand, and the browser that executed it opens this panel.
 */
export interface PanelDefinition {
  /** Slash command name without the slash (lowercase letters, digits, underscore, dash). */
  readonly command: string
  /** Title shown in the shell header bar. */
  readonly title: string
  /** Content component rendered inside the shell card. */
  readonly component: PanelComponent
  /**
   * Capability filter evaluated when the command executes: return false to
   * keep the panel closed for that session (e.g. non-ops presets).
   */
  readonly available?: (sessionId: string) => boolean
}

/**
 * The ctx.opsPanels client service face (plural key — a registry).
 * Registration is an effect: the returned disposer removes the panel.
 */
export interface OpsPanels {
  /**
   * Register one panel. Duplicate command names throw at registration.
   * @param def - the panel identity and content.
   * @returns disposer removing the panel.
   */
  registerPanel(def: PanelDefinition): () => void
  /**
   * Open a panel without a slash command (ADR-0004 §9): the imperative
   * path for ambient affordances — e.g. the access-request badge pulling
   * up the approval deck while a request_access call parks.
   * @param sessionId - the session whose overlay hosts the panel.
   * @param command - the panel's command name.
   * @returns false when nothing is registered for the command or the
   *   panel's capability filter declines this session.
   */
  open(sessionId: string, command: string): boolean
  /**
   * Dismiss the session's open panel. No-op when none is open.
   * @param sessionId - the session whose panel to close.
   */
  close(sessionId: string): void
}

/** Spec for the node-side slash command that triggers a panel. */
export interface PanelCommandSpec {
  /** Command name without the slash; must match the panel command field. */
  readonly name: string
  /** Menu row description. */
  readonly description: string
}

