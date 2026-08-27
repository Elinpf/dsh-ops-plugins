/**
 * inventory spec: persistence shape, header, determinism, stale-on-failure
 * semantics, and the credential-discipline guarantees of the written file.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildClusterInventory,
  readInventory,
  refreshInventory,
} from '../src/inventory.js'
import { scanCluster } from '../src/scanner.js'
import { FAKE_KUBECONFIG, fakeExec, fakeFetch, fakeSpawn, failSpawn } from './helper.ts'

const NOW = new Date('2026-08-27T00:00:00Z')
const NO_USER_RULES = '/nonexistent/environment-rules.yaml'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'env-inventory-')), 'environment.yaml')
}

describe('refreshInventory — happy path', () => {
  it('writes a segmented file with header, timestamps, middleware and edges', async () => {
    const file = tempFile()
    const { exec } = fakeExec()
    const inventory = await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec, now: NOW, userRulesFile: NO_USER_RULES },
    )

    const section = inventory.clusters['pf-test']
    expect(section.scannedAt).toBe('2026-08-27T00:00:00.000Z')
    expect(section.stale).toBeUndefined()

    // Middleware instances recognized from the fixture.
    const types = section.middleware.map(m => `${m.namespace}/${m.workload}:${m.type}`).sort()
    expect(types).toEqual([
      'baizeops/postgres:postgres',
      'baizeops/redis:redis',
      'monitoring/prometheus:prometheus',
    ])
    expect(section.middleware.find(m => m.workload === 'postgres')!.serviceEntries).toEqual(['postgres'])

    // Unknown bucket: in-house apps stay listed; node-exporter is infra.
    const unknowns = section.workloads.filter(w => w.type === 'unknown').map(w => w.name).sort()
    expect(unknowns).toEqual(['gateway', 'user-service'])
    expect(section.workloads.find(w => w.name === 'node-exporter')!.type).toBe('infra')
    expect(section.workloads.find(w => w.name === 'coredns')!.type).toBe('infra')

    // Relation edges made it in.
    expect(section.edges.some(e => e.kind === 'uses-middleware'
      && e.from.name === 'user-service' && e.to.name === 'postgres')).toBe(true)

    // Header + round-trip.
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('# AUTO-GENERATED')).toBe(true)
    expect(text).toContain('DO NOT EDIT BY HAND')
    const back = await readInventory(file)
    expect(back).toEqual(inventory)
  })

  it('is deterministic: scanning the same cluster twice yields identical bytes', async () => {
    const file = tempFile()
    const first = await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec: fakeExec().exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    const firstText = readFileSync(file, 'utf8')
    const second = await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec: fakeExec().exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    expect(second).toEqual(first)
    expect(readFileSync(file, 'utf8')).toBe(firstText)
  })
})

describe('refreshInventory — stale semantics', () => {
  it('cluster failure keeps the old section and marks it stale', async () => {
    const file = tempFile()
    await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec: fakeExec().exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )

    const later = new Date('2026-08-27T01:00:00Z')
    const inventory = await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec: fakeExec({ failFor: ['*'] }).exec, spawn: failSpawn, now: later, userRulesFile: NO_USER_RULES },
    )

    const section = inventory.clusters['pf-test']
    // Old data retained with the ORIGINAL timestamp…
    expect(section.scannedAt).toBe('2026-08-27T00:00:00.000Z')
    expect(section.middleware).toHaveLength(3)
    // …marked stale with a sanitized error.
    expect(section.stale).toBe(true)
    expect(section.lastError).toBeDefined()
    expect(section.lastError).not.toContain(FAKE_KUBECONFIG)
    expect(section.lastError).toContain('<kubeconfig>')
  })

  it('a cluster with no previous data gets an empty stale section — visible, not missing', async () => {
    const file = tempFile()
    const inventory = await refreshInventory(
      [{ cluster: 'down-cluster', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec: fakeExec({ failFor: ['*'] }).exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    const section = inventory.clusters['down-cluster']
    expect(section.stale).toBe(true)
    expect(section.middleware).toEqual([])
    expect(section.workloads).toEqual([])
  })

  it('one failing cluster does not affect the others', async () => {
    const file = tempFile()
    const inventory = await refreshInventory(
      [
        { cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG },
        { cluster: 'down-cluster', kubeconfigPath: '/other/kubeconfig' },
      ],
      { file, exec: fakeExec({ failFor: [] }).exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    expect(inventory.clusters['pf-test'].stale).toBeUndefined()
    // fakeExec serves fixtures for both; down-cluster is fine here. Now fail it.
    const second = await refreshInventory(
      [{ cluster: 'down-cluster', kubeconfigPath: '/other/kubeconfig' }],
      { file, exec: fakeExec({ failFor: ['*'] }).exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    expect(second.clusters['down-cluster'].stale).toBe(true)
    // Untouched cluster keeps its section verbatim.
    expect(second.clusters['pf-test'].stale).toBeUndefined()
    expect(second.clusters['pf-test'].middleware).toHaveLength(3)
  })
})

describe('credential discipline of the written file', () => {
  it('the YAML contains no kubeconfig path and no Secret values', async () => {
    const file = tempFile()
    // First a good scan, then a failing one — so both data AND error text
    // are in the file when we assert.
    await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec: fakeExec().exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec: fakeExec({ failFor: ['*'] }).exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(FAKE_KUBECONFIG)
    expect(text).not.toContain('/home/tester')
    expect(text).not.toContain('DB_PASSWORD')
    expect(text).not.toContain('stringData')
    // Secret reference NAMES are expected — that is the allowed level.
    expect(text).toContain('baizeops-secret')
  })
})

describe('readInventory', () => {
  it('returns null for a missing file', async () => {
    expect(await readInventory('/nonexistent/environment.yaml')).toBeNull()
  })

  it('returns null for a malformed file', async () => {
    const file = tempFile()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, 'just a scalar')
    expect(await readInventory(file)).toBeNull()
  })
})

describe('buildClusterInventory', () => {
  it('sorts output for stable snapshots', async () => {
    const { exec } = fakeExec()
    const scan = await scanCluster({
      cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG, exec, spawn: failSpawn, now: NOW,
    })
    const inventory = buildClusterInventory(scan, { userRulesFile: NO_USER_RULES })
    const names = inventory.workloads.map(w => `${w.namespace}/${w.name}`)
    expect([...names].sort()).toEqual(names)
  })
})

describe('prometheus corroboration in the persisted inventory', () => {
  it('attaches monitoring counts to workloads and middleware, and records the source service', async () => {
    const file = tempFile()
    const { exec } = fakeExec()
    const { spawn } = fakeSpawn({ ready: true })
    const inventory = await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec, spawn, fetchFn: fakeFetch, now: NOW, userRulesFile: NO_USER_RULES },
    )

    const section = inventory.clusters['pf-test']
    expect(section.prometheusService).toBe('monitoring/prometheus')

    const postgres = section.middleware.find(m => m.workload === 'postgres')!
    expect(postgres.monitoring).toEqual({ up: 1, down: 0 })
    const redis = section.middleware.find(m => m.workload === 'redis')!
    expect(redis.monitoring).toEqual({ up: 1, down: 1 })

    const userService = section.workloads.find(w => w.name === 'user-service')!
    expect(userService.monitoring).toEqual({ up: 1, down: 0 })
    // No Prometheus data for workloads without matching targets.
    expect(section.workloads.find(w => w.name === 'coredns')!.monitoring).toBeUndefined()

    // The written YAML carries the counts, and the round-trip keeps them.
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('monitoring')
    const back = await readInventory(file)
    expect(back!.clusters['pf-test'].middleware.find(m => m.workload === 'redis')!.monitoring)
      .toEqual({ up: 1, down: 1 })
  })

  it('a cluster without Prometheus gets no monitoring fields at all', async () => {
    const file = tempFile()
    const { exec } = fakeExec()
    const inventory = await refreshInventory(
      [{ cluster: 'pf-test', kubeconfigPath: FAKE_KUBECONFIG }],
      { file, exec, spawn: failSpawn, now: NOW, userRulesFile: NO_USER_RULES },
    )
    const section = inventory.clusters['pf-test']
    expect(section.prometheusService).toBeUndefined()
    expect(section.stale).toBeUndefined() // enhancement failure is NOT staleness
    expect(section.middleware.every(m => m.monitoring === undefined)).toBe(true)
  })
})
