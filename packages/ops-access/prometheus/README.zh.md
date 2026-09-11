# @elinpf/dsh-ops-access-prometheus

运维模式 Prometheus 凭证 provider — 校验 `prometheus` 注册表条目(服务器 URL + 可选 bearer token)并展开 token 路径。

## 功能

按 ops-access 三角色拆分,一种凭证一个 provider:core 拥有注册表和 `ctx.opsAccess` 服务;本包只提供 prometheus 这一种 — 一个 zod 条目 schema 加字段处理。

- **条目 schema**:`{ url, token? }` — `url` 是 Prometheus 服务器的 base URL(仅 http(s))。`token` 是可选的 bearer-token 内容:管理 UI / `register_access` 接受粘贴的 token,core 将其写入 `~/.dsh-ops/credentials/` 下的受管文件并存路径 — token 本身不进注册表。
- **process**:剥掉 URL 末尾的斜杠,展开 token 路径开头的 `~`。
- **validateContent**:保存时的粘贴防护 — token 必须是单行(它会原样进 `Authorization` 头,内部换行会在请求时失败)。只查结构,不做连通性检查。
- **无能力探测**:Prometheus HTTP API 天然只读(`query`/`query_range`),没有 ro/rw 之分可核验。`knownLimits` 写明这一点,并提示与同集群的 k8s 档案配对使用。

## 安装

ops preset 的 `agent.cordis.yml` 中的 provider 行:

```yaml
- id: ops-access-prometheus
  name: '@elinpf/dsh-ops-access-prometheus'
```

注册走 `registerAccessProvider`(延迟 `ctx.inject` + effect 生命周期,HMR 可卸载)— 绝不静态 `inject` `opsAccess`,那会死锁加载器。

## 测试

```sh
npm run build      # tsc → lib/
npx vitest run     # schema、process、粘贴防护、注册/HMR 卸载
```

无需服务器:全部测试只打纯 provider 对象和 mock 挂载。
