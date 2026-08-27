/**
 * classify spec: the built-in middleware table, the infra class, the unknown
 * bucket, and the user rules file (append + override, tolerant of bad files).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinRules, classifySignals, classifyWorkload, isMiddlewareType, loadUserRules } from '../src/classify.js'

function byImage(image: string, labels: Record<string, string> = {}): string {
  return classifySignals({ images: [image], labels }, builtinRules)
}

describe('built-in table — middleware (spec 0003 list)', () => {
  const cases: Array<[string, string]> = [
    ['nacos/nacos-server:v2.3.2', 'nacos'],
    ['registry.example.com/middleware/sentinel-dashboard:1.8.7', 'sentinel'],
    ['seataio/seata-server:1.7.0', 'seata'],
    ['redis:7.2', 'redis'],
    ['docker.elastic.co/elasticsearch/elasticsearch:8.14.0', 'elasticsearch'],
    ['bitnami/kafka:3.7', 'kafka'],
    ['mysql:8.0', 'mysql'],
    ['clickhouse/clickhouse-server:24.3', 'clickhouse'],
    ['minio/minio:RELEASE.2024-06-01', 'minio'],
    ['milvusdb/milvus:v2.4.5', 'milvus'],
    ['emqx/emqx:5.7', 'mqtt'],
    ['eclipse-mosquitto:2.0', 'mqtt'],
    ['mongo:6.0', 'mongodb'],
    ['mongodb:7.0', 'mongodb'],
    ['postgres:16.2', 'postgres'],
    ['prom/prometheus:v2.53.0', 'prometheus'],
  ]
  it.each(cases)('image %s classifies as %s', (image, type) => {
    expect(byImage(image)).toBe(type)
  })

  it('exporters classify as infra plumbing, not their middleware', () => {
    expect(byImage('oliver006/redis_exporter:v1.55')).toBe('infra')
    expect(byImage('prom/mysqld-exporter:v0.15')).toBe('infra')
  })

  it('monitoring-suite members do not all collapse into prometheus', () => {
    expect(byImage('quay.io/prometheus/node-exporter:v1.8')).toBe('infra')
    expect(byImage('registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12')).toBe('infra')
    expect(byImage('quay.io/prometheus-operator/prometheus-config-reloader:v0.81.0')).toBe('infra')
    expect(byImage('quay.io/prometheus-operator/prometheus-operator:v0.81.0')).toBe('infra')
    expect(byImage('grafana/grafana:11.1.0')).toBe('grafana')
    expect(byImage('prom/alertmanager:v0.28.1')).toBe('alertmanager')
  })
})

describe('built-in table — infra class', () => {
  it.each([
    ['quay.io/jetstack/cert-manager-controller:v1.15'],
    ['registry.k8s.io/coredns/coredns:v1.11.1'],
    ['chaos-mesh/chaos-mesh:v2.6'],
  ])('image %s is infra, not middleware', (image) => {
    expect(byImage(image)).toBe('infra')
    expect(isMiddlewareType('infra')).toBe(false)
  })
})

describe('labels and charts as signals', () => {
  it('helm labels classify a prometheus sts even under a mirrored image', () => {
    const type = classifySignals({
      images: ['registry.example.com/middleware/prometheus:v2.53.0'],
      labels: { 'app.kubernetes.io/name': 'prometheus', 'helm.sh/chart': 'prometheus-25.8.0' },
    }, builtinRules)
    expect(type).toBe('prometheus')
  })

  it('chart label alone can carry the classification', () => {
    const type = classifySignals({
      images: ['registry.example.com/mirror/a1b2c3:latest'],
      labels: { 'helm.sh/chart': 'redis-19.6.0' },
    }, builtinRules)
    expect(type).toBe('redis')
  })
})

describe('unknown bucket', () => {
  it('an in-house app image without labels is unknown, not dropped', () => {
    expect(byImage('registry.example.com/acme/user-service:1.4.2')).toBe('unknown')
  })
})

describe('user rules file', () => {
  function rulesFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'env-rules-'))
    const file = join(dir, 'environment-rules.yaml')
    writeFileSync(file, content)
    return file
  }

  it('appends rules: an in-house app becomes classifiable', () => {
    const file = rulesFile('rules:\n  - pattern: "acme/user-service"\n    type: app\n')
    const type = classifyWorkload(
      { images: ['registry.example.com/acme/user-service:1.4.2'], labels: {} },
      { userRulesFile: file },
    )
    expect(type).toBe('app')
  })

  it('overrides built-ins: user rules are consulted first', () => {
    const file = rulesFile('rules:\n  - pattern: "\\\\bredis\\\\b"\n    type: cache\n')
    const type = classifyWorkload({ images: ['redis:7.2'], labels: {} }, { userRulesFile: file })
    expect(type).toBe('cache')
  })

  it('missing file falls back to built-ins only', () => {
    expect(loadUserRules('/nonexistent/environment-rules.yaml')).toEqual([])
    expect(byImage('redis:7.2')).toBe('redis')
  })

  it('malformed file falls back to built-ins only', () => {
    const file = rulesFile('rules: [ { broken')
    expect(loadUserRules(file)).toEqual([])
  })

  it('skips entries without string pattern/type and broken regexes', () => {
    const file = rulesFile([
      'rules:',
      '  - pattern: 42',
      '    type: app',
      '  - pattern: "ok"',
      '  - pattern: "([bad"',
      '    type: app',
      '  - pattern: "registry.example.com/acme"',
      '    type: app',
    ].join('\n'))
    const rules = loadUserRules(file)
    expect(rules).toEqual([{ pattern: 'registry.example.com/acme', type: 'app' }])
  })

  it('expands ~ in the rules file path', () => {
    // Default path is ~/.dsh-ops/environment-rules.yaml; a missing default
    // must silently yield no user rules.
    expect(loadUserRules()).toEqual(loadUserRules('~/.dsh-ops/environment-rules.yaml'))
  })
})
