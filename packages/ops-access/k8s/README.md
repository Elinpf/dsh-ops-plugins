# @deepseek-ai/dsh-ops-access-k8s

The Kubernetes credential-kind provider for the ops-access capability seam — validates `k8s` registry entries, expands kubeconfig paths, and probes real permissions at save time.

## What it does

One provider per credential kind is the ops-access split rule: this package carries everything Kubernetes-specific and nothing else. It registers an `AccessProvider` (`kind: 'k8s'`) into `ctx.opsAccess` via the core package's `registerAccessProvider` helper — an effect, so fiber disposal/HMR unregisters it.

- **Zod entry schema**: `{ kubeconfig }` — one path per profile.
- **Field processing**: `~` expansion; the resolved field is `kubeconfigPath` (paths only — secret material never passes through any service).
- **Save-time paste guard** (`validateContent`): structural YAML validation — clusters/contexts/users present, and `current-context` must name a defined context (the ops tools never pass `--context`, so a stale current-context breaks every call at runtime; catch it at save time).
- **Save-time capability probe** (`kubectl auth can-i`): read = `get pods`, write = `create deployments`. `ro` verifies when reading works and writing is denied; `rw` verifies when both work. Unreachable cluster or missing kubectl degrades to `unverifiable`, never a silent "no". Facet checks (`services/proxy`, `pods/exec`) annotate the result but never gate it — subresource can-i verdicts can be wrong.
- **Agent-facing docs**: `fieldsDoc` and `derivationDoc` feed `list_access` help — the latter is the ro self-derivation recipe (ServiceAccount `<id>-ro` + view ClusterRole + long-lived token, verified in both directions).

## Design notes

- The provider is a plain data object (`provider` export); `apply` only binds the configured probe timeouts and registers it. The pure verdict function `assessK8sTier` is exported and unit-tested directly, so the can-i matrix logic never needs a live cluster in tests.
- kubectl stderr is never surfaced — it echoes the kubeconfig path in its errors.

## Configuration

```yaml
- id: ops-access-k8s
  name: '@deepseek-ai/dsh-ops-access-k8s'
```

| Key | Default | Meaning |
|---|---|---|
| `probeTimeoutMs` | `10000` | Timeout per `kubectl auth can-i` call (ms). Slow clusters may need more. |
| `probeNamespace` | `default` | Namespace the can-i probe checks permissions in. |

## Testing

```sh
npm run build
npx vitest run
```

Unit tests cover schema accept/reject, `~` expansion, registration/disposal through a mock `opsAccess` context (effect cleanup actually removes the provider), the paste guard, and the pure `assessK8sTier` verdict matrix. The one live-kubectl test asserts degradation to `unverifiable` against a nonexistent kubeconfig.
