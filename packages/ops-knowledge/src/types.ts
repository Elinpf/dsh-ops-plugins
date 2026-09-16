/**
 * Types for the ops-knowledge plugin.
 *
 * The wire shape mirrors the hub's `/cases` API (camelCase there); tool
 * arguments facing the model use snake_case and are mapped in index.ts.
 *
 * @module @elinpf/dsh-ops-knowledge/types
 */

/** A full case record as the hub returns it from `GET /cases/:id`. */
export interface CaseRecord {
  id: string
  title: string
  symptoms: string[]
  rootCause: string
  fix: string
  evidence?: string
  /** How the root cause was found — the discriminating steps/commands (方法论). */
  methodology?: string
  /** Self-assessed diagnosis difficulty, 1–5. */
  difficulty?: number
  tags: string[]
  environment?: string
  hitCount: number
  createdAt: string
  updatedAt: string
}

/** An index row as the hub returns it from `GET /cases` — no full text. */
export interface CaseIndexRow {
  id: string
  title: string
  symptoms: string[]
  tags: string[]
  hitCount: number
  updatedAt: string
}

/** Fields a caller may write on a case. */
export interface CaseInput {
  title?: string
  symptoms?: string[]
  rootCause?: string
  fix?: string
  evidence?: string
  methodology?: string
  difficulty?: number
  tags?: string[]
  environment?: string
}

/**
 * A search hit: the full case plus its relevance score. Matches the tool
 * output schema exactly — the runtime rejects undeclared keys, so this is
 * `Omit<CaseRecord, 'createdAt'>`, not a blind spread of the wire record.
 */
export interface CaseMatch extends Omit<CaseRecord, 'createdAt'> {
  score: number
}

/** Result shape shared by the three tools. */
export interface KnowledgeToolResult {
  action: 'record' | 'search' | 'hit'
  note?: string
  error?: string
  id?: string
  /** search: matched cases, best first. */
  matches?: CaseMatch[]
}
