# @deepseek-ai/dsh-ops-kubectl

ops-access 能力缝的 kubectl 消费工具 — 把 `k8s` profile 解析成 kubeconfig 路径并通过 `ctx.shell` 执行 kubectl；另有 `list_access` 工具列出已注册 profile(不含任何凭据字段)。

## 功能

注册两个面向模型的工具:

- **`kubectl`** — 每次调用按名字解析一个 `k8s` access profile,把 profile 的 `--kubeconfig` 路径注入后经本地 shell 执行子命令。实际执行的命令带真实路径;模型可见的结果里显示 `<id@tier:field>` 凭据引用,秘密不会进入日志或模型上下文。
- **`list_access`** — 把 `ctx.opsAccess.listAll()` 按 kind 分组,只显示信封字段(name、displayName、description、environment)加各 tier 就绪状态(`ro`/`rw`)和能力核验标注。profile 的 `fields`(路径、连接参数)永不进入工具输出。`help: true` 返回注册表管理文档。

## 设计要点

- **瘦消费者,共享机制。** 本包只提供四个身份要素 — 工具名、解析 kind(`k8s`)、profile 参数名(`cluster`)、`buildCommand`。标准结果形状(`{ exitCode, stdout, stderr, command, error? }`)、输出 schema、render 和逐次解析的执行模板(默认 30s 超时、信号死亡归一为 exitCode -1)都在 `@deepseek-ai/dsh-ops-shell-tool`,保证 kubectl/ceph/ssh 三个工具行为一致。
- **逐次解析,绝不缓存。** ops-access 缝在 `execute` 内通过 `ctx.get('opsAccess')` 获取 — 不做静态 inject、不缓存 — 注册表改完即生效,也不会在加载器里和兄弟服务死锁。
- **无会话状态。** 工具不追加会话事件、不拥有 projection,每次调用互相独立。`./invariant` 子路径只带一个"无运行时 invariant"的伴生插件,用于在 invariants 服务上登记包归属。

## 配置

```yaml
- id: tool-ops-kubectl
  name: '@deepseek-ai/dsh-ops-kubectl'
  config:
    timeoutMs: 30000   # kubectl 单次调用的 shell 超时(毫秒);集群慢可调大
```

## 子路径导出

- `@deepseek-ai/dsh-ops-kubectl/types` — 纯类型(`ListedProfile`、`ListAccessResult`),零运行时代码。
- `@deepseek-ai/dsh-ops-kubectl/invariant` — invariant 伴生插件。

## 测试

```sh
npm run build     # tsc → lib/
npx vitest run    # 单测用 mock context 驱动真实插件:
                  # kubectl 正常路径 + 失败回退、render 纯函数性、
                  # list_access 分组与 no-fields 保证、
                  # 导出形态、HMR 卸载(disposer 清空注册表)
```
