# @deepseek-ai/dsh-ops-access

运维访问能力缝（capability seam）— 持有 YAML 凭据注册表（默认 `~/.dsh-ops/access.yaml`），向 provider 插件和消费工具暴露 `ctx.opsAccess`（resolve / list / register）。

## 功能

- **单注册表文件、零缓存**：每次 `resolve`/`list`/`writeEntry` 都重新读取、解析、校验 YAML — 改文件立即生效，无需重启。
- **分层条目**：每个 profile 携带 `ro` 层（agent 默认可读）和 `rw` 层（只有注册了 broker 授权后才发放）。
- **Provider 缝**：每种凭据类型一个 provider（`k8s`/`ceph`/`ssh` 包），只提供 zod schema 加字段处理（`~` 展开、内容校验、能力探测）。provider 通过 `registerAccessProvider(ctx, provider)` 注册 — 绝不要手写 `ctx.inject` 依赖兄弟服务，会死锁 loader。
- **`register_access` 工具**：agent 自助写入 ro 层的路径（rw 层始终由人通过 admin HTTP 路由管理）。
- **Mention 支持**：`@[kind/name](dsh-access:<payload>)` mention 在 `agent/pre-step` 上被解析、重写为可读引用并注入 envelope 上下文；`GET /ops-access/list` 给浏览器的 `@` 选择器供数。编码在 `./mention` 子路径。
- **Admin 路由**：`GET /ops-access/admin/list`、`GET /ops-access/admin/kinds`、`GET|POST|DELETE /ops-access/admin/entry` — 只出 envelope + 校验状态，绝不出字段值。

## 设计要点

- **秘密不过境**：profile 只携带文件路径和连接参数 — 日志、报错、模型上下文都不可能含秘密材料。文件字段保存后只写不读（`getEntry` 连存储路径都不返回）。
- **为什么这样拆**：core 持有注册表文件和服务；provider 持有各类型的字段知识；消费工具（`ops-tool-kubectl` 等）持有命令拼装。三方各自独立演进。
- **broker 而非内置守门**：策略（谁能读 rw）住在注册的 `AccessBroker` 里 — 一个纯决策函数，每次 resolve 都咨询。没有 broker 时 resolve 与之前逐字节一致地发 ro。
- **一切皆 effect**：工具、路由、provider 和 broker 注册都绑在 cordis effect 生命周期上，fiber 销毁 / HMR 卸载会干净移除。

## 配置

```yaml
- id: ops-access
  name: '@deepseek-ai/dsh-ops-access'
  registryFile: ~/.dsh-ops/access.yaml   # 默认值
  credentialsDir: ~/.dsh-ops/credentials # 默认值；托管凭据内容文件（0600）
```

## 测试

```sh
npm run build      # tsc → lib/
npx vitest run     # spec 用 mock context 驱动真实插件，
                   # 注册表是真实的 tmp 目录文件
```

## 已知限制和待办事项

- 无缓存意味着每次调用一次 stat+解析 — 运维规模的注册表下没问题。
- `ssh` provider 无法做能力探测（没有只读 shell 可测）— 其分层保持未探测状态。
- 注册表文件按设计可人工编辑；没有并发写锁。
