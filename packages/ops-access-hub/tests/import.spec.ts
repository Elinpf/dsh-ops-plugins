/**
 * Spec for the YAML registry importer: path-shaped single-line values become
 * file content (absolute / `~` / relative-to-registry paths), everything else
 * passes through, and an unreadable path-shaped value aborts with an error
 * naming the entry and field. Also covers pushing into a running hub and
 * direct-to-store writes.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyToStore, importRegistry, pushToHub } from '../src/import.ts'
import { HubStore } from '../src/store.ts'
import { createHubServer } from '../src/server.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-import-'))
})

function writeRegistry(yaml: string): string {
  const file = join(dir, 'access.yaml')
  writeFileSync(file, yaml)
  return file
}

describe('importRegistry', () => {
  it('inlines path-shaped single-line values and passes the rest through', async () => {
    mkdirSync(join(dir, 'creds'), { recursive: true })
    writeFileSync(join(dir, 'creds', 'kubeconfig'), 'KUBECONFIG-CONTENT\n')
    writeFileSync(join(dir, 'rel-key.pem'), 'REL-KEY-CONTENT')

    const home = mkdtempSync(join(tmpdir(), 'hub-import-home-'))
    writeFileSync(join(home, 'home-token'), 'HOME-TOKEN')
    const oldHome = process.env.HOME
    process.env.HOME = home
    try {
      const file = writeRegistry(`version: 1
k8s:
  prod:
    description: 生产集群
    environment: prod
    ro:
      kubeconfig: ${join(dir, 'creds', 'kubeconfig')}
      endpoint: https://k8s.internal
      replicas: 3
    rw:
      token: ~/home-token
ssh:
  bastion:
    name: 跳板机
    ro:
      key: ./rel-key.pem
      note: |
        multi
        line
`)
      const { entries, stats } = await importRegistry(file)

      const prod = entries.find((e) => e.kind === 'k8s' && e.name === 'prod')
      expect(prod?.envelope).toEqual({ description: '生产集群', environment: 'prod' })
      expect(prod?.tiers.ro?.fields.kubeconfig).toBe('KUBECONFIG-CONTENT\n')
      expect(prod?.tiers.ro?.fields.endpoint).toBe('https://k8s.internal')
      expect(prod?.tiers.ro?.fields.replicas).toBe(3)
      expect(prod?.tiers.rw?.fields.token).toBe('HOME-TOKEN')

      const bastion = entries.find((e) => e.kind === 'ssh')
      expect(bastion?.envelope).toEqual({ name: '跳板机' })
      // Relative paths resolve against the registry file's directory.
      expect(bastion?.tiers.ro?.fields.key).toBe('REL-KEY-CONTENT')
      // Multi-line strings are never treated as paths.
      expect(bastion?.tiers.ro?.fields.note).toBe('multi\nline\n')

      expect(stats).toEqual({ entries: 2, tiers: 3, fileFields: 3 })
    } finally {
      process.env.HOME = oldHome
    }
  })

  it('aborts on an unreadable path-shaped value, naming entry and field', async () => {
    const file = writeRegistry(`version: 1
k8s:
  prod:
    ro:
      kubeconfig: /nonexistent/definitely-missing-file
`)
    await expect(importRegistry(file)).rejects.toThrow(/k8s\/prod/)
    await expect(importRegistry(file)).rejects.toThrow(/ro\.kubeconfig/)
  })

  it('rejects a malformed registry', async () => {
    const file = writeRegistry(`version: 1
k8s: just-a-string
`)
    await expect(importRegistry(file)).rejects.toThrow(/kind 'k8s'/)
  })

  it('lifts the auto-managed probe key to the tier level instead of importing it as a field', async () => {
    const file = writeRegistry(`version: 1
k8s:
  prod:
    ro:
      endpoint: https://k8s.internal
      probe:
        status: verified
        detail: "facets: services/proxy=yes"
        probedAt: 2026-09-03T05:37:55.406Z
`)
    const { entries } = await importRegistry(file)
    const ro = entries[0]?.tiers.ro
    expect(ro?.fields).toEqual({ endpoint: 'https://k8s.internal' })
    expect(ro?.probe).toEqual({
      status: 'verified',
      detail: 'facets: services/proxy=yes',
      probedAt: '2026-09-03T05:37:55.406Z',
    })
  })
})

describe('import targets', () => {
  let server: Server
  let hubDir: string

  afterEach(async () => {
    if (server) await new Promise((resolveClose) => server.close(resolveClose))
  })

  it('pushToHub PUTs every tier into a running hub', async () => {
    hubDir = mkdtempSync(join(tmpdir(), 'hub-import-target-'))
    const store = new HubStore({ dataDir: hubDir })
    await store.init()
    server = createHubServer({ store, adminToken: 'adm', readToken: 'rd' })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const { entries } = await importRegistry(writeRegistry(`version: 1
k8s:
  prod:
    environment: prod
    ro:
      endpoint: https://k8s.internal
    rw:
      endpoint: https://k8s.internal
`))
    await pushToHub(url, 'adm', entries)
    const entry = store.getEntry('k8s', 'prod')
    expect(entry?.tiers.ro?.fields.endpoint).toBe('https://k8s.internal')
    expect(entry?.tiers.rw).toBeDefined()
    expect(entry?.envelope).toEqual({ environment: 'prod' })
  })

  it('applyToStore writes entries offline and they persist', async () => {
    hubDir = mkdtempSync(join(tmpdir(), 'hub-import-target-'))
    const store = new HubStore({ dataDir: hubDir })
    await store.init()
    const { entries, stats } = await importRegistry(writeRegistry(`version: 1
ceph:
  main:
    ro:
      mon: 10.0.0.1
`))
    applyToStore(store, entries)
    await store.save()
    expect(stats.entries).toBe(1)

    const reopened = new HubStore({ dataDir: hubDir })
    await reopened.init()
    expect(reopened.getEntry('ceph', 'main')?.tiers.ro?.fields).toEqual({ mon: '10.0.0.1' })
  })
})
