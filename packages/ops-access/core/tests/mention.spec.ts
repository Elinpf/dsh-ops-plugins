/**
 * Unit spec for the dsh-access mention encoding: canonical URI round-trip,
 * Markdown mention formatting/parsing, readable-text rewriting.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeAccessReferenceUri,
  encodeAccessReferenceUri,
  formatAccessMention,
  parseAccessReferenceText,
} from '../src/mention.ts'

describe('encode/decode round-trip', () => {
  it('round-trips a kind/name pair', () => {
    const uri = encodeAccessReferenceUri({ kind: 'k8s', name: 'prod' })
    expect(uri.startsWith('dsh-access:')).toBe(true)
    expect(decodeAccessReferenceUri(uri)).toEqual({ kind: 'k8s', name: 'prod' })
  })

  it('round-trips names with special characters', () => {
    const ref = { kind: 'ssh', name: 'node-1 (北京)/odd' }
    expect(decodeAccessReferenceUri(encodeAccessReferenceUri(ref))).toEqual(ref)
  })

  it('rejects wrong scheme, malformed payload, and non-pair JSON', () => {
    expect(() => decodeAccessReferenceUri('dsh-session:abc')).toThrow(/invalid access reference URI/)
    expect(() => decodeAccessReferenceUri('dsh-access:not valid!')).toThrow(/invalid access reference URI/)
    const notPair = 'dsh-access:' + Buffer.from(JSON.stringify({ kind: 'k8s' }), 'utf8').toString('base64url')
    expect(() => decodeAccessReferenceUri(notPair)).toThrow(/invalid access reference URI/)
  })
})

describe('formatAccessMention', () => {
  it('renders a Markdown mention with kind/name label', () => {
    const mention = formatAccessMention({ kind: 'ceph', name: 'rook-test' })
    expect(mention).toMatch(/^@\[ceph\/rook-test\]\(dsh-access:[A-Za-z0-9_-]+\)$/)
  })
})

describe('parseAccessReferenceText', () => {
  it('rewrites mentions to readable @label and extracts references in order', () => {
    const a = formatAccessMention({ kind: 'k8s', name: 'prod' })
    const b = formatAccessMention({ kind: 'ssh', name: 'node-1' })
    const parsed = parseAccessReferenceText(`看下 ${a} 和 ${b} 的状态`)
    expect(parsed.text).toBe('看下 @k8s/prod 和 @ssh/node-1 的状态')
    expect(parsed.references).toEqual([
      { kind: 'k8s', name: 'prod', label: 'k8s/prod' },
      { kind: 'ssh', name: 'node-1', label: 'ssh/node-1' },
    ])
  })

  it('handles bare canonical URIs without the Markdown wrapper', () => {
    const bare = encodeAccessReferenceUri({ kind: 'ceph', name: 'main' })
    const parsed = parseAccessReferenceText(`直接贴 ${bare} 进来`)
    expect(parsed.text).toBe('直接贴 @ceph/main 进来')
    expect(parsed.references).toEqual([{ kind: 'ceph', name: 'main', label: 'ceph/main' }])
  })

  it('leaves ordinary text and other mention schemes untouched', () => {
    const parsed = parseAccessReferenceText('hello @world and @[s](dsh-session:abc123)')
    expect(parsed.text).toBe('hello @world and @[s](dsh-session:abc123)')
    expect(parsed.references).toEqual([])
  })
})
