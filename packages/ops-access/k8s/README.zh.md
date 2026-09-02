# @elinpf/dsh-ops-access-k8s

ops-access 能力缝的 Kubernetes 凭证种类 provider — 校验 `k8s` 注册表条目、展开 kubeconfig 路径，并在保存时探测真实权限。

## 功能

按 ops-access 的拆分规则，一种凭证一个 provider：本包只装 Kubernetes 专属的东西。它通过 core 包的 `registerAccessProvider` 帮助函数向 `ctx.opsAccess` 注册一个 `AccessProvider`（`kind: 'k8s'`）——注册走 effect，fiber 销毁 / HMR 时自动卸载。

- **zod 条目 schema**：`{ kubeconfig }` — 一个 profile 一个路径。
- **字段处理**：`~` 展开；解析后输出 `kubeconfigPath`（只有路径 — 机密材料从不经过任何 service）。
- **保存时粘贴守卫**（`validateContent`）：结构化 YAML 校验 — clusters/contexts/users 必须存在，且 `current-context` 必须指向已定义的 context（ops 工具从不传 `--context`，current-context 失效会让运行时每次调用都挂，必须在保存时拦住）。
- **保存时能力探测**（`kubectl auth can-i`）：读 = `get pods`，写 = `create deployments`。`ro` 在能读且不能写时验证通过；`rw` 在两者都行时通过。集群不可达或没有 kubectl 时降级为 `unverifiable`，绝不静默当作 "no"。facet 检查（`services/proxy`、`pods/exec`）只做标注不做门槛 — 子资源的 can-i 判定可能不准。
- **面向 agent 的文档**：`fieldsDoc` 和 `derivationDoc` 喂给 `list_access` 的 help — 后者是 ro 自助派生配方（ServiceAccount `<id>-ro` + view ClusterRole + 长效 token，双向验证）。

## 设计要点

- provider 是纯数据对象（`provider` 导出）；`apply` 只做一件事：绑定配置里的探测超时并注册。纯判定函数 `assessK8sTier` 单独导出、直接单测，因此 can-i 矩阵逻辑在测试里不需要真实集群。
- kubectl 的 stderr 从不外抛 — 它的报错里会带出 kubeconfig 路径。

## 配置项

```yaml
- id: ops-access-k8s
  name: '@elinpf/dsh-ops-access-k8s'
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `probeTimeoutMs` | `10000` | 每次 `kubectl auth can-i` 调用的超时（毫秒）。慢集群可调大。 |
| `probeNamespace` | `default` | can-i 探测权限所用的 namespace。 |

## 测试方式

```sh
npm run build
npx vitest run
```

单测覆盖：schema 接受/拒绝、`~` 展开、经 mock `opsAccess` 上下文的注册/卸载（effect 清理会真正把 provider 移除）、粘贴守卫、以及纯函数 `assessK8sTier` 的判定矩阵。唯一的 live-kubectl 测试断言对不存在的 kubeconfig 会降级为 `unverifiable`。
