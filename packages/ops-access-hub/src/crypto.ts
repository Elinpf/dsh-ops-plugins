/**
 * At-rest encryption for the hub data document.
 *
 * AES-256-GCM with a random 12-byte nonce per write. The on-disk file is a
 * base64-encoded JSON document `{ nonce, data }` where `data` is
 * ciphertext || 16-byte auth tag — a text container (chosen over raw binary
 * concatenation) so the file stays inspectable and survives text-oriented
 * tooling.
 *
 * The master key is 32 bytes and comes from, in priority order:
 *
 * 1. env `ACCESS_HUB_KEY` — base64 or hex (64 hex chars, checked first since
 *    a hex string is also valid base64 input);
 * 2. a key file (default `<data-dir>/hub.key`, base64-encoded) — generated
 *    on first start with mode 0600 when absent.
 *
 * @module
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const MASTER_KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Generate a fresh random master key. */
export function generateMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES)
}

/**
 * Parse a master key from its text form: 64 hex chars, or base64 decoding to
 * exactly 32 bytes. Hex is tried first (a hex string also parses as base64).
 */
export function parseMasterKey(raw: string): Buffer {
  const text = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
  const key = Buffer.from(text, 'base64')
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`invalid master key: expected ${MASTER_KEY_BYTES} bytes (base64 or hex)`)
  }
  return key
}

/**
 * Resolve the master key: `envKey` wins; otherwise read `keyFile`, generating
 * it (mode 0600, parent dirs created) on first start.
 */
export async function loadMasterKey(opts: { envKey?: string; keyFile: string }): Promise<Buffer> {
  if (opts.envKey) return parseMasterKey(opts.envKey)
  try {
    return parseMasterKey(await readFile(opts.keyFile, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const key = generateMasterKey()
  await mkdir(dirname(opts.keyFile), { recursive: true })
  await writeFile(opts.keyFile, key.toString('base64') + '\n', { mode: 0o600 })
  return key
}

/** Encrypt a UTF-8 document; returns the base64 text container for the file. */
export function encryptDoc(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return Buffer.from(JSON.stringify({ nonce: nonce.toString('base64'), data: data.toString('base64') }), 'utf8')
    .toString('base64')
}

/** Decrypt a document produced by {@link encryptDoc}; throws on any tampering (GCM tag check). */
export function decryptDoc(blob: string, key: Buffer): string {
  const packed = JSON.parse(Buffer.from(blob.trim(), 'base64').toString('utf8')) as { nonce: string; data: string }
  const nonce = Buffer.from(packed.nonce, 'base64')
  const data = Buffer.from(packed.data, 'base64')
  if (nonce.length !== NONCE_BYTES || data.length < TAG_BYTES) throw new Error('corrupt hub data file')
  const tag = data.subarray(data.length - TAG_BYTES)
  const ciphertext = data.subarray(0, data.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
