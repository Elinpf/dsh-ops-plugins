/**
 * dsh-access mention encoding — the structured form of an `@` pick on an
 * access profile, mirroring session-reference's `dsh-session:` pattern.
 *
 * A mention is a host-neutral Markdown span `@[kind/name](dsh-access:<payload>)`
 * where the payload is base64url(JSON [kind, name]). The composer draft shows
 * the label; on submit the full mention travels in the message text; the
 * preset-plane `agent/pre-step` listener (src/index.ts) parses it back out,
 * rewrites the text to a readable `@kind/name`, and injects the profiles'
 * envelope context.
 *
 * Host-side only — the browser never encodes or parses these; the remote
 * hands it ready-made mention strings.
 *
 * @module @deepseek-ai/dsh-ops-access/mention
 */

/** URI scheme reserved for ops access-profile references. */
export const ACCESS_REFERENCE_SCHEME = 'dsh-access:'

/** One referenced access profile. */
export interface AccessReference {
  kind: string
  name: string
}

/** A parsed reference with its display label, in first-appearance order. */
export interface ParsedAccessReference extends AccessReference {
  label: string
}

/** Result of extracting mentions from plain text. */
export interface ParsedAccessReferenceText {
  /** Text with opaque mention spans replaced by readable `@label`. */
  text: string
  /** Structured references in first-appearance order (not deduplicated). */
  references: ParsedAccessReference[]
}

/**
 * Encode a profile reference as a canonical lossless URI.
 * @param reference - kind + name of the profile.
 * @returns canonical `dsh-access:` URI.
 */
export function encodeAccessReferenceUri(reference: AccessReference): string {
  const payload = Buffer.from(JSON.stringify([reference.kind, reference.name]), 'utf8').toString('base64url')
  return `${ACCESS_REFERENCE_SCHEME}${payload}`
}

/**
 * Decode and canonicalize one access-reference URI.
 * @param uri - complete canonical URI.
 * @returns decoded kind + name.
 */
export function decodeAccessReferenceUri(uri: string): AccessReference {
  if (!uri.startsWith(ACCESS_REFERENCE_SCHEME)) {
    throw invalidUri(uri)
  }
  const payload = uri.slice(ACCESS_REFERENCE_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw invalidUri(uri)
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
      throw new TypeError('decoded payload is not a [kind, name] pair')
    }
    const reference: AccessReference = { kind: parsed[0], name: parsed[1] }
    if (encodeAccessReferenceUri(reference) !== uri) throw new TypeError('URI is not canonical')
    return reference
  } catch (error: unknown) {
    throw invalidUri(uri, error)
  }
}

/**
 * Render the Markdown mention the composer inserts into the draft.
 * @param reference - kind + name of the profile.
 * @returns escaped `@[kind/name](uri)` mention.
 */
export function formatAccessMention(reference: AccessReference): string {
  const label = escapeLabel(`${reference.kind}/${reference.name}`)
  return `@[${label}](${encodeAccessReferenceUri(reference)})`
}

/**
 * Extract Markdown mentions and bare canonical URIs from one text value,
 * replacing them with readable `@label` spans.
 * @param text - host text to normalize.
 * @returns readable text and structured references in appearance order.
 */
export function parseAccessReferenceText(text: string): ParsedAccessReferenceText {
  const references: ParsedAccessReference[] = []
  const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-access:[^\s)]*)\)|(dsh-access:[A-Za-z0-9_-]+)/gu
  const rendered = text.replace(pattern, (
    _match,
    rawLabel: string | undefined,
    markdownUri: string | undefined,
    bareUri: string | undefined,
  ) => {
    const uri = markdownUri ?? bareUri
    /* v8 ignore next -- the two-alternative regex always captures exactly one URI group */
    if (uri === undefined) throw new Error('access reference URI is missing')
    const reference = decodeAccessReferenceUri(uri)
    const label = rawLabel === undefined ? `${reference.kind}/${reference.name}` : unescapeLabel(rawLabel)
    references.push({ ...reference, label })
    return `@${label}`
  })
  return { text: rendered, references }
}

function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/gu, '$1')
}

function invalidUri(uri: string, cause?: unknown): Error {
  return new Error(
    `invalid access reference URI ${JSON.stringify(uri)}`,
    cause === undefined ? undefined : { cause },
  )
}
