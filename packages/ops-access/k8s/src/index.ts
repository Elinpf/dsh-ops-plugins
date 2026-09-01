/**
 * Ops access provider for Kubernetes.
 *
 * Validates `k8s` registry entries (`{ kubeconfig }`) and expands the
 * kubeconfig path, exposing it as `kubeconfigPath`. Registers into the
 * ops-access capability seam (ctx.opsAccess).
 *
 * @module @deepseek-ai/dsh-ops-access-k8s
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { parse as parseYaml } from 'yaml'
import { execFile } from 'node:child_process'
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-k8s'

export const inject: string[] = []

export const Config = z.object({
  /** Save-time probe: timeout per `kubectl auth can-i` call (ms). Slow clusters may need more. */
  probeTimeoutMs: z.number().default(10000),
  /** Namespace the can-i probe checks permissions in. */
  probeNamespace: z.string().default('default'),
})

// ── Provider ─────────────────────────────────────────────────────────────────

/** Zod schema for one k8s registry entry (excluding name and envelope fields). */
export const entrySchema = zod.object({
  kubeconfig: zod.string(),
})

export const provider: AccessProvider = {
  kind: 'k8s',
  schema: entrySchema,
  fieldsDoc: 'kubeconfig: path to the kubeconfig file (~ is expanded)',
  fileFields: ['kubeconfig'],
  derivationDoc: "from the rw kubeconfig: create a ServiceAccount named <id>-ro (naming convention), bind it to the built-in view ClusterRole (read-most, no Secret contents), mint a long-lived token via a Secret of type kubernetes.io/service-account-token for the SA (kubectl create token output expires); extract the cluster server and CA with kubectl config view --raw (without --raw the CA shows as DATA+OMITTED); build the ro kubeconfig reusing the rw cluster entry, naming both context and user <id>-ro and setting current-context to <id>-ro (kubectl cannot select a context without it); register it via register_access; then verify BOTH directions — kubectl get pods must succeed and a write attempt (e.g. kubectl create configmap ro-write-check --dry-run=server) must be forbidden. If every rw call fails with 'context was not found', the rw kubeconfig's current-context is broken — report it to the operator instead of working around it with --context",
  process(entry) {
    const { kubeconfig } = entry as zod.infer<typeof entrySchema>
    return { kubeconfigPath: expandHome(kubeconfig) }
  },
  // Save-time guard against corrupt pastes: a kubeconfig must be a YAML
  // mapping with clusters, contexts, and users. Structural only — no
  // connectivity checks.
  // Ticket 10: verify the credential's real permissions at save time.
  probe: probeK8s,
  validateContent(field, content) {
    if (field !== 'kubeconfig') return null
    let doc: unknown
    try {
      doc = parseYaml(content)
    } catch (err) {
      const first = String((err as Error | null)?.message ?? err).split('\n')[0]
      return `not valid YAML: ${first}`
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return 'not a YAML mapping — paste the full kubeconfig file'
    }
    const d = doc as Record<string, unknown>
    if (!Array.isArray(d.clusters) || d.clusters.length === 0) return 'no clusters defined — paste the full kubeconfig file'
    if (!Array.isArray(d.contexts) || d.contexts.length === 0) return 'no contexts defined — paste the full kubeconfig file'
    if (!Array.isArray(d.users) || d.users.length === 0) return 'no users (credentials) defined — paste the full kubeconfig file'
    // current-context must name a defined context: the ops kubectl tool
    // never passes --context, so a missing or stale current-context breaks
    // EVERY call at runtime ("no context currently selected" / "context was
    // not found"). Catch it at save time instead.
    const contextNames = d.contexts
      .map((c) => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>).name : undefined))
      .filter((n): n is string => typeof n === 'string')
    const current = d['current-context']
    if (typeof current !== 'string' || current === '') {
      return `no current-context — kubectl cannot select a context without one (the ops tools do not pass --context). Defined contexts: ${contextNames.join(', ') || '(none)'}`
    }
    if (!contextNames.includes(current)) {
      return `current-context "${current}" does not match any defined context (defined: ${contextNames.join(', ') || '(none)'}) — fix it before saving`
    }
    return null
  },
}


// ── Capability probe (ticket 10) ─────────────────────────────────────────────

/**
 * Pure tier assessment from the can-i matrix (unit-tested directly):
 * read = can-i get pods, write = can-i create deployments. ro verifies when
 * reading works and writing is denied; rw verifies when both work.
 */
// K8sProbeFacets lives in types.ts (types-only module); re-exported here so
// existing `from './index.js'` type imports keep working.
export type { K8sProbeFacets } from './types.js'
import type { K8sProbeFacets } from './types.js'

function fmtVerdict(v: boolean | null): string {
  return v === null ? 'unknown' : v ? 'yes' : 'no'
}

export function assessK8sTier(read: boolean, write: boolean, tier: 'ro' | 'rw', facets?: K8sProbeFacets): { status: 'verified' | 'mismatch', detail?: string } {
  // Facets ANNOTATE, never gate: subresource can-i verdicts can be wrong
  // (the ticket-14 pods/portforward quirk), so they ride along as facts.
  const facetNote = facets === undefined ? undefined : 'facets: services/proxy=' + fmtVerdict(facets.servicesProxy) + ', pods/exec=' + fmtVerdict(facets.podsExec)
  const join = (base?: string): string | undefined => [base, facetNote].filter(Boolean).join(' · ') || undefined
  if (tier === 'ro') {
    if (read && !write) return { status: 'verified', ...(facetNote === undefined ? {} : { detail: facetNote }) }
    if (write) return { status: 'mismatch', detail: join('claims ro but can-i create deployments = yes — an over-privileged credential sits in the ro slot') }
    return { status: 'mismatch', detail: join('claims ro but can-i get pods = no — the credential cannot even read') }
  }
  if (read && write) return { status: 'verified', ...(facetNote === undefined ? {} : { detail: facetNote }) }
  return { status: 'mismatch', detail: join('claims rw but can-i says: get pods=' + (read ? 'yes' : 'no') + ', create deployments=' + (write ? 'yes' : 'no')) }
}

/**
 * One can-i verdict: true/false from kubectl's answer, null when the check
 * itself could not run (unreachable cluster, missing binary). stderr is
 * never surfaced — kubectl echoes the kubeconfig path in its errors.
 */
function canI(kubeconfig: string, verb: string, resource: string, timeoutMs: number, namespace: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('kubectl', ['--kubeconfig', kubeconfig, 'auth', 'can-i', verb, resource, '-n', namespace],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { resolve(null); return }
        const answer = (stdout ?? '').trim().toLowerCase()
        if (answer.startsWith('yes')) { resolve(true); return }
        if (answer.startsWith('no')) { resolve(false); return }
        // kubectl exits 1 with the verdict on stdout for 'no', but a
        // connection failure produces no verdict at all. Any answer that
        // is not a clean yes/no verdict means the check itself failed —
        // unverifiable, never a silent 'no' (review fix).
        resolve(null)
      })
  })
}

async function probeK8s(fields: Record<string, unknown>, tier: 'ro' | 'rw', timeoutMs = 10000, namespace = 'default') {
  const kubeconfig = String(fields.kubeconfigPath ?? '')
  const [read, write, servicesProxy, podsExec] = await Promise.all([
    canI(kubeconfig, 'get', 'pods', timeoutMs, namespace),
    canI(kubeconfig, 'create', 'deployments', timeoutMs, namespace),
    canI(kubeconfig, 'get', 'services/proxy', timeoutMs, namespace),
    canI(kubeconfig, 'create', 'pods/exec', timeoutMs, namespace),
  ])
  if (read === null || write === null) {
    return { status: 'unverifiable' as const, detail: 'kubectl auth can-i could not run (cluster unreachable or kubectl missing)' }
  }
  return assessK8sTier(read, write, tier, { servicesProxy, podsExec })
}
// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: { probeTimeoutMs: number, probeNamespace: string }): void {
  registerAccessProvider(ctx, {
    ...provider,
    probe: (fields, tier) => probeK8s(fields, tier, config.probeTimeoutMs, config.probeNamespace),
  })
}
