/**
 * Named-token model for the hub (ADR-0009).
 *
 * A hub used to speak exactly two shared, environment-injected Bearer tokens
 * (one admin, one read). That is enough for "one consumer, one operator", but
 * not for a team: everybody shares the same secret, nobody can be revoked
 * alone, and an audit line cannot say *who* resolved a credential.
 *
 * A named token is an independently issued credential with a human label, a
 * role (`admin`/`read`) and an optional expiry. Only the SHA-256 digest of the
 * plaintext is persisted — the plaintext is returned exactly once, by the
 * create call, and has no recovery path. The label becomes the audit `actor`,
 * so every recorded action names the holder.
 *
 * The static env/flag tokens stay valid as bootstrap/break-glass credentials
 * (see `./server.js`), so revoking every named token can never lock the
 * operator out of the hub.
 *
 * This module is pure: it holds the model, the minting/hashing helpers and
 * the input parsers; persistence lives in `./store.js`.
 *
 * @module
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export type TokenRole = 'admin' | 'read'

/** Roles a named token may carry; anything else is a 400. */
export const TOKEN_ROLES: readonly TokenRole[] = ['admin', 'read']

/**
 * Token label charset — unicode letters/digits first, then letters/digits and
 * `. _ @ + -` plus spaces, 1..64 characters. Deliberately wider than
 * `NAME_PATTERN`: a label names a *person* (Chinese names are expected) and
 * only ever travels in a JSON body and the audit log, never in a path.
 */
export const TOKEN_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._@+ -]{0,63}$/u

/** Hard cap on issued-but-not-purged token records (the store owns the doc). */
export const MAX_TOKENS = 200

/** Entropy behind every issued token: 24 random bytes → 32 base64url chars. */
const TOKEN_BYTES = 24

/** How many plaintext characters of a token are kept for identification. */
export const TOKEN_PREFIX_CHARS = 8

/**
 * One issued credential. `hash` is the only material stored for the secret
 * itself; `prefix` exists so an operator can tell two live tokens apart in a
 * listing without the hub being able to re-display them.
 */
export interface HubToken {
  id: string
  /** Human label of the holder; unique among non-revoked tokens; recorded as the audit `actor`. */
  name: string
  role: TokenRole
  /** SHA-256 hex of the plaintext token — the plaintext itself is never stored. */
  hash: string
  /** First {@link TOKEN_PREFIX_CHARS} characters of the plaintext, for identification only. */
  prefix: string
  createdAt: string
  /** Label of the issuer (a named-token name, or `cli` for offline issuance). */
  createdBy: string
  /** Optional ISO expiry; once past, the token authenticates as invalid. */
  expiresAt?: string
  /** Set when revoked; a revoked token can never authenticate again. */
  revokedAt?: string
}

/** Metadata-safe projection of a token — never carries `hash`. */
export type TokenView = Omit<HubToken, 'hash'>

/** Mint a fresh plaintext token (the only copy that will ever exist). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** SHA-256 hex digest of a plaintext token; what the store keeps and compares. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** The identifying head of a plaintext token. */
export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_CHARS)
}

/** Constant-time comparison of two hex digests (same length always). */
export function hashEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** A token still accepts requests when it is neither revoked nor expired. */
export function isTokenActive(token: Pick<HubToken, 'revokedAt' | 'expiresAt'>, now = new Date().toISOString()): boolean {
  if (token.revokedAt !== undefined) return false
  if (token.expiresAt !== undefined && token.expiresAt <= now) return false
  return true
}

/** Drop the digest before a token record leaves the process. */
export function toTokenView(token: HubToken): TokenView {
  const { hash: _hash, ...view } = token
  return view
}

/** Parse a role from a request body; throws on anything but `admin`/`read`. */
export function parseTokenRole(raw: unknown): TokenRole {
  if (raw === 'admin' || raw === 'read') return raw
  throw new Error("role must be 'admin' or 'read'")
}

/** Parse and trim a token label; throws when it cannot name a person safely. */
export function parseTokenName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('name must be a string')
  const name = raw.trim()
  if (!TOKEN_NAME_PATTERN.test(name)) {
    throw new Error(`invalid name: must match ${TOKEN_NAME_PATTERN.source} (1..64 chars)`)
  }
  return name
}

/** Parse an optional ISO expiry; throws when it is unparseable or already past. */
export function parseExpiresAt(raw: unknown, now = new Date()): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw new Error('expiresAt must be an ISO date string')
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) throw new Error('expiresAt must be an ISO date string')
  if (ms <= now.getTime()) throw new Error('expiresAt must be in the future')
  return new Date(ms).toISOString()
}
