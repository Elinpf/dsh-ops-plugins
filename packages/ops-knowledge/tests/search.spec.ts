/**
 * Unit spec for the keyword scoring in src/search.ts.
 */

import { describe, expect, it } from 'vitest'
import { queryTokens, rankCases, scoreRow } from '../src/search.ts'
import type { CaseIndexRow } from '../src/types.ts'

function row(partial: Partial<CaseIndexRow>): CaseIndexRow {
  return { id: 'x', title: '', symptoms: [], tags: [], hitCount: 0, updatedAt: '', ...partial }
}

describe('queryTokens', () => {
  it('splits on whitespace and appends the whole query', () => {
    expect(queryTokens('csi stuck')).toEqual(['csi', 'stuck', 'csi stuck'])
    expect(queryTokens('csi')).toEqual(['csi'])
    expect(queryTokens('  ')).toEqual([])
  })

  it('matches case-insensitively', () => {
    expect(scoreRow(row({ title: 'CSI 卡住' }), ['csi'])).toBeGreaterThan(0)
  })
})

describe('scoreRow', () => {
  it('weights title ×3, tags ×2, symptoms ×2 per token', () => {
    const tokens = ['ceph']
    expect(scoreRow(row({ title: 'ceph 满' }), tokens)).toBe(3)
    expect(scoreRow(row({ tags: ['ceph'] }), tokens)).toBe(2)
    expect(scoreRow(row({ symptoms: ['ceph osd down'] }), tokens)).toBe(2)
    expect(scoreRow(row({}), tokens)).toBe(0)
  })
})

describe('rankCases', () => {
  it('drops non-matches, sorts by score then hitCount', () => {
    const rows = [
      row({ id: 'a', title: '网络分区', hitCount: 5 }),
      row({ id: 'b', symptoms: ['pvc pending'], tags: ['ceph'], hitCount: 0 }),
      row({ id: 'c', title: 'ceph 相关', hitCount: 0 }),
      row({ id: 'd', title: 'ceph 也相关', hitCount: 9 }),
    ]
    const ranked = rankCases(rows, 'ceph')
    expect(ranked.map((m) => m.row.id)).toEqual(['d', 'c', 'b']) // d/c tie on title score → hitCount breaks the tie
  })

  it('returns nothing for an empty query', () => {
    expect(rankCases([row({ title: 'x' })], '  ')).toEqual([])
  })
})
