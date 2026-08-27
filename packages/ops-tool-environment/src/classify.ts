/**
 * Middleware classification table.
 *
 * A workload is classified from three signal sources — image names, chart
 * names, and labels — matched against an ordered rule list. First match wins.
 * Built-in rules cover the common middleware of the ops environment; a user
 * rules file (default `~/.dsh-ops/environment-rules.yaml`) can append or
 * override them: user rules are consulted before built-in ones.
 *
 * Types are plain strings: a middleware name ('redis', 'mysql', ...),
 * 'infra' for cluster plumbing (cert-manager, coredns, chaos-mesh, ...),
 * or 'unknown' when nothing matches. 'unknown' is not an error — those
 * workloads form the unknown bucket and stay visible.
 *
 * User rules file format:
 *
 *   rules:
 *     - pattern: 'my-internal-mq'   # case-insensitive regex
 *       type: mqtt
 *
 * @module @deepseek-ai/dsh-ops-tool-environment
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import { parse as parseYaml } from 'yaml'
import type { ScannedWorkload } from './types.js'

/** One classification rule: a case-insensitive regex mapped to a type. */
export interface ClassificationRule {
  /** Regex source, matched case-insensitively against image/chart/label signals. */
  pattern: string
  /** Type assigned on match ('redis', 'infra', a company-specific name, ...). */
  type: string
}

/** Signals a workload is classified on. */
export interface ClassifyInput {
  images: string[]
  labels: Record<string, string>
  /** Workload name — a weak signal, only used by rules that want it. */
  name?: string
}

export const DEFAULT_USER_RULES_FILE = '~/.dsh-ops/environment-rules.yaml'

/**
 * Built-in table. Ordered: more specific patterns before generic ones so
 * e.g. `redis-exporter` classifies as prometheus plumbing before `redis`
 * would claim it. Infra components map to the 'infra' type, not a middleware.
 */
export const builtinRules: ClassificationRule[] = [
  // ── exporters / sidecars before their middleware ────────────────────────
  { pattern: 'redis[-_.]exporter', type: 'infra' },
  { pattern: 'mysql[-_.]exporter', type: 'infra' },
  { pattern: 'elasticsearch[-_.]exporter', type: 'infra' },
  { pattern: 'kafka[-_.]exporter', type: 'infra' },
  { pattern: 'mongodb[-_.]exporter', type: 'infra' },
  { pattern: 'postgres[-_.]exporter', type: 'infra' },
  { pattern: 'mysqld[-_.]exporter', type: 'infra' },
  // ── middleware (spec 0003 list) ─────────────────────────────────────────
  { pattern: 'nacos', type: 'nacos' },
  { pattern: 'sentinel', type: 'sentinel' },
  { pattern: 'seata', type: 'seata' },
  { pattern: '\\bredis\\b', type: 'redis' },
  { pattern: 'elasticsearch', type: 'elasticsearch' },
  { pattern: '\\bkafka\\b', type: 'kafka' },
  { pattern: '\\bmysql\\b', type: 'mysql' },
  { pattern: '\\bmariadb\\b', type: 'mysql' },
  { pattern: 'clickhouse', type: 'clickhouse' },
  { pattern: '\\bminio\\b', type: 'minio' },
  { pattern: '\\bmilvus\\b', type: 'milvus' },
  { pattern: '\\bemqx\\b', type: 'mqtt' },
  { pattern: 'mosquitto', type: 'mqtt' },
  { pattern: 'hivemq', type: 'mqtt' },
  { pattern: 'vernemq', type: 'mqtt' },
  { pattern: '\\bmongo\\b', type: 'mongodb' },
  { pattern: 'mongodb', type: 'mongodb' },
  { pattern: '\\bpostgres\\b', type: 'postgres' },
  { pattern: 'postgresql', type: 'postgres' },
  // ── monitoring-suite members before the generic prometheus rule ─────────
  { pattern: 'node[-_.]exporter', type: 'infra' },
  { pattern: 'kube-state-metrics', type: 'infra' },
  { pattern: 'prometheus-config-reloader', type: 'infra' },
  { pattern: 'prometheus-operator', type: 'infra' },
  { pattern: '\\bgrafana\\b', type: 'grafana' },
  { pattern: '\\balertmanager\\b', type: 'alertmanager' },
  { pattern: 'prometheus', type: 'prometheus' },
  // common companions of the listed middleware
  { pattern: '\\bzookeeper\\b', type: 'zookeeper' },
  { pattern: '\\brabbitmq\\b', type: 'rabbitmq' },
  { pattern: '\\bnats\\b', type: 'nats' },
  { pattern: '\\bconsul\\b', type: 'consul' },
  { pattern: '\\betcd\\b', type: 'etcd' },
  // ── infra (cluster plumbing, not middleware) ────────────────────────────
  { pattern: 'cert-manager', type: 'infra' },
  { pattern: 'coredns', type: 'infra' },
  { pattern: 'chaos-mesh', type: 'infra' },
  { pattern: 'chaos-daemon', type: 'infra' },
  { pattern: 'ingress-nginx', type: 'infra' },
  { pattern: 'nginx-ingress', type: 'infra' },
  { pattern: 'metrics-server', type: 'infra' },
  { pattern: '\\bcalico\\b', type: 'infra' },
  { pattern: '\\bcilium\\b', type: 'infra' },
  { pattern: 'kube-proxy', type: 'infra' },
  { pattern: 'local-path-provisioner', type: 'infra' },
  { pattern: '\\btraefik\\b', type: 'infra' },
]

export function expandHome(p: string): string {
  const home = process.env.HOME ?? os.homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p
}

/**
 * Load user classification rules. Missing or malformed file is not an
 * error — the built-in table alone still works — so this always resolves
 * to a (possibly empty) rule list. Entries without a string pattern/type
 * are skipped.
 */
export function loadUserRules(file: string = DEFAULT_USER_RULES_FILE): ClassificationRule[] {
  let text: string
  try {
    text = readFileSync(expandHome(file), 'utf8')
  } catch {
    return []
  }
  try {
    const doc = parseYaml(text) as { rules?: unknown } | null
    if (!doc || !Array.isArray(doc.rules)) return []
    const rules: ClassificationRule[] = []
    for (const entry of doc.rules) {
      if (!entry || typeof entry !== 'object') continue
      const { pattern, type } = entry as { pattern?: unknown, type?: unknown }
      if (typeof pattern !== 'string' || typeof type !== 'string') continue
      try {
        new RegExp(pattern) // validate — a broken regex skips this entry only
      } catch {
        continue
      }
      rules.push({ pattern, type })
    }
    return rules
  } catch {
    return []
  }
}

/**
 * Candidate signal strings for a workload: image basenames (tag stripped)
 * and full images, chart-ish label values, and every label as `key=value`.
 */
function signalsOf(input: ClassifyInput): string[] {
  const signals: string[] = []
  for (const image of input.images) {
    const basename = image.split('/').pop() ?? image
    signals.push(basename.replace(/:[^:]*$/, ''), basename, image)
  }
  for (const [key, value] of Object.entries(input.labels)) {
    signals.push(value, `${key}=${value}`)
  }
  if (input.name) signals.push(input.name)
  return signals
}

/** Classify one signal set against an ordered rule list; first match wins. */
export function classifySignals(input: ClassifyInput, rules: ClassificationRule[]): string {
  const compiled = rules.map(r => ({ re: new RegExp(r.pattern, 'i'), type: r.type }))
  for (const signal of signalsOf(input)) {
    for (const { re, type } of compiled) {
      if (re.test(signal)) return type
    }
  }
  return 'unknown'
}

/**
 * Classify a scanned workload. Loads built-in rules, then overlays the user
 * rules file (user rules win ties — they are consulted first).
 */
export function classifyWorkload(
  workload: Pick<ScannedWorkload, 'images' | 'labels' | 'name'>,
  opts: { userRulesFile?: string, extraRules?: ClassificationRule[] } = {},
): string {
  const userRules = opts.extraRules ?? loadUserRules(opts.userRulesFile)
  return classifySignals(workload, [...userRules, ...builtinRules])
}

/** True for the middleware types worth surfacing as instances (not infra, not unknown). */
export function isMiddlewareType(type: string): boolean {
  return type !== 'unknown' && type !== 'infra'
}
