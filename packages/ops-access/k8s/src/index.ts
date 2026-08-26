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
import type { AccessProvider } from '@deepseek-ai/dsh-ops-access'
import { expandHome, registerAccessProvider } from '@deepseek-ai/dsh-ops-access'

// ── Plugin identity ───────────────────────────────────────────────────────────

export const name = 'ops-access-k8s'

export const inject: string[] = []

export const Config = z.object({})

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

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  registerAccessProvider(ctx, provider)
}
