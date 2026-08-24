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
  process(entry) {
    const { kubeconfig } = entry as zod.infer<typeof entrySchema>
    return { kubeconfigPath: expandHome(kubeconfig) }
  },
}

// ── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, _config: Record<string, never>): void {
  registerAccessProvider(ctx, provider)
}
