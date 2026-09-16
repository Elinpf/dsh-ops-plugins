/**
 * Keyword relevance scoring over the case index. Deliberately simple:
 * case-insensitive substring matching, weighted by field — title ×3,
 * tags ×2, symptoms ×2. No embeddings; scores are predictable and the
 * index is small (hundreds at most).
 *
 * @module @elinpf/dsh-ops-knowledge/search
 */

import type { CaseIndexRow } from './types.js'

/** Split a query into lowercase match tokens (whitespace-separated, plus the whole query). */
export function queryTokens(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '')
  const whole = query.trim().toLowerCase()
  if (whole !== '' && !tokens.includes(whole)) tokens.push(whole)
  return tokens
}

/** Score one index row against the query tokens; 0 means no match. */
export function scoreRow(row: CaseIndexRow, tokens: string[]): number {
  const title = row.title.toLowerCase()
  const tags = row.tags.map((t) => t.toLowerCase())
  const symptoms = row.symptoms.map((s) => s.toLowerCase())
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 3
    if (tags.some((t) => t.includes(token))) score += 2
    if (symptoms.some((s) => s.includes(token))) score += 2
  }
  return score
}

/** Rank index rows by relevance; rows with no match drop out. */
export function rankCases(rows: CaseIndexRow[], query: string): Array<{ row: CaseIndexRow; score: number }> {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  return rows
    .map((row) => ({ row, score: scoreRow(row, tokens) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.row.hitCount - a.row.hitCount)
}
