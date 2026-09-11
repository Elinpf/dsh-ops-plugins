/**
 * Unit spec for the at-rest crypto layer: encrypt/decrypt round-trip, GCM
 * tamper detection, master-key parsing (hex/base64), and key-file first-start
 * generation with mode 0600.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decryptDoc,
  encryptDoc,
  generateMasterKey,
  loadMasterKey,
  parseMasterKey,
} from '../src/crypto.ts'
import { mktmpdir } from './tmpdir.ts'

describe('encryptDoc/decryptDoc', () => {
  it('round-trips a JSON document', () => {
    const key = generateMasterKey()
    const plaintext = JSON.stringify({ version: 1, entries: { 'k8s/prod': { secret: 's3cr3t' } } })
    expect(decryptDoc(encryptDoc(plaintext, key), key)).toBe(plaintext)
  })

  it('uses a random nonce: same plaintext encrypts differently', () => {
    const key = generateMasterKey()
    expect(encryptDoc('same', key)).not.toBe(encryptDoc('same', key))
  })

  it('fails to decrypt when the auth tag is tampered with', () => {
    const key = generateMasterKey()
    const blob = encryptDoc('sensitive', key)
    // Flip one byte inside the base64 payload (last char covers the tag region).
    const tampered = blob.slice(0, -2) + (blob.endsWith('AA') ? 'BB' : 'AA')
    expect(() => decryptDoc(tampered, key)).toThrow()
  })

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptDoc('sensitive', generateMasterKey())
    expect(() => decryptDoc(blob, generateMasterKey())).toThrow()
  })
})

describe('parseMasterKey', () => {
  it('accepts 64 hex chars', () => {
    const key = generateMasterKey()
    expect(parseMasterKey(key.toString('hex')).equals(key)).toBe(true)
  })

  it('accepts base64 of 32 bytes', () => {
    const key = generateMasterKey()
    expect(parseMasterKey(key.toString('base64')).equals(key)).toBe(true)
  })

  it('rejects garbage', () => {
    expect(() => parseMasterKey('not-a-key')).toThrow(/invalid master key/)
  })
})

describe('loadMasterKey', () => {
  it('generates the key file on first start with mode 0600 and reuses it after', async () => {
    const dir = mktmpdir('hub-crypto-')
    const keyFile = join(dir, 'nested', 'hub.key')
    const first = await loadMasterKey({ keyFile })
    expect(first.length).toBe(32)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const second = await loadMasterKey({ keyFile })
    expect(second.equals(first)).toBe(true)
  })

  it('prefers the env key and does not create the key file', async () => {
    const dir = mktmpdir('hub-crypto-')
    const keyFile = join(dir, 'hub.key')
    const envKey = generateMasterKey()
    const key = await loadMasterKey({ envKey: envKey.toString('base64'), keyFile })
    expect(key.equals(envKey)).toBe(true)
    expect(() => statSync(keyFile)).toThrow()
  })
})
