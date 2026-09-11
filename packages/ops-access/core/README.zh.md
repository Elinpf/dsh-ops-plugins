# @elinpf/dsh-ops-access

运维访问能力缝（capability seam）— 持有 YAML 凭据注册表（默认 `~/.dsh-ops/access.yaml`），向 provider 插件和消费工具暴露 `ctx.opsAccess`（resolve / list / register）。

## 功能

- **单注册表文件、零缓存**：每次 `resolve`/`list`/`writeEntry` 都重新读取、解析、校验 YAML — 改文件立即生效，无需重启。
- **分层条目**：每个 profile 携带 `ro` 层（agent 默认可读）和 `rw` 层（只有注册了 broker 授权后才发放）。
- **Provider 缝**：每种凭据类型一个 provider（`k8s`/`ceph`/`ssh` 包），只提供 zod schema 加字段处理（`~` 展开、内容校验、能力探测）。provider 通过 `registerAccessProvider(ctx, provider)` 注册 — 绝不要手写 `ctx.inject` 依赖兄弟服务，会死锁 loader。
- **引用字段**（`references`）：provider 可声明某字段指向另一个种类的条目（ssh 的 `cred` → `ssh-cred`），让多个条目共享一份凭证而不是各自复制。resolve 时 core 把被引用条目的字段合并到引用方**之下**（同注册表、同 tier、只展开一层）；broker 只被咨询一次，针对引用方条目。`validateResolved` 是合并后的校验钩子，承载只在合并形状上成立的要求（ssh 的登录用户可来自任一侧）。悬挂引用会让引用方的 resolve 及其 `canResolve` 预检一起失败。
- **`register_access` 工具**：agent 自助写入 ro 层的路径；传 `tier: "rw"` 则**提交 rw 注册申请**（仅 hub 模式，ADR-0008）——申请排队在 hub 上，管理员在凭证管理设置区审查字段内容并批准后才真正写入。
- **Mention 支持**：`@[kind/name](dsh-access:<payload>)` mention 在 `agent/pre-step` 上被解析、重写为可读引用并注入 envelope 上下文；`GET /ops-access/list` 给浏览器的 `@` 选择器供数。编码在 `./mention` 子路径。
- **Admin 路由**：`GET /ops-access/admin/list`、`GET /ops-access/admin/kinds`、`GET|POST|DELETE /ops-access/admin/entry` — 只出 envelope + 校验状态，绝不出字段值。
- **可插拔凭证来源**（`source`）：`yaml`（默认）读本地注册表文件；`hub` 每次调用都从独立部署的 [ops-access-hub](../../ops-access-hub/) 服务拉取。hub 模式下，文件类字段的内容物化到**独立的缓存目录**（`hubCacheDir`，默认 `~/.dsh-ops/hub-cache`），是受 TTL 约束的缓存（`materializeTtlMinutes`，默认 15 分钟），**绝不是永久副本**：启动时全量清扫（grant 账本随进程消亡，缓存的 rw 材料不得比它活得久），定时清扫按年龄过期，resolve 现取现物化、到期透明重建。yaml 模式的 `credentialsDir`（文档化的回退路径）永不被清扫。

## 设计要点

- **秘密不过境**：profile 只携带文件路径和连接参数 — 日志、报错、模型上下文都不可能含秘密材料。文件字段保存后只写不读（`getEntry` 连存储路径都不返回）。
- **为什么这样拆**：core 持有注册表文件和服务；provider 持有各类型的字段知识；消费工具（`ops-tool-kubectl` 等）持有命令拼装。三方各自独立演进。
- **broker 而非内置守门**：策略（谁能读 rw）住在注册的 `AccessBroker` 里 — 一个纯决策函数，每次 resolve 都咨询。没有 broker 时 resolve 与之前逐字节一致地发 ro。
- **一切皆 effect**：工具、路由、provider 和 broker 注册都绑在 cordis effect 生命周期上，fiber 销毁 / HMR 卸载会干净移除。

## 配置

```yaml
- id: ops-access
  name: '@elinpf/dsh-ops-access'
  registryFile: ~/.dsh-ops/access.yaml   # 默认值
  credentialsDir: ~/.dsh-ops/credentials # 默认值；托管凭据内容文件（0600）
  # source: hub                          # 可选；默认 yaml
  # hubUrl: http://127.0.0.1:3090        # hub 来源：hub 服务地址
  # hubToken: ...                        # hub 来源：读 token（或用环境变量 ACCESS_HUB_READ_TOKEN）
  # hubAdminToken: ...                   # hub 来源：写 token（或用环境变量 ACCESS_HUB_ADMIN_TOKEN）
  # hubCacheDir: ~/.dsh-ops/hub-cache    # hub 来源：TTL 物化缓存目录（绝不用 credentialsDir）
  # materializeTtlMinutes: 15            # hub 来源：缓存 TTL；启动时全量清扫
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
