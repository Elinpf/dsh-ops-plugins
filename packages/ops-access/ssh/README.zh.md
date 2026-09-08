# @elinpf/dsh-ops-access-ssh

ops access 接缝的 SSH provider — 两个凭证种类:`ssh`(主机条目)和 `ssh-cred`(可复用凭证条目),一把密钥或一个密码只登记一次,任意多台主机共享。

## 功能

`@elinpf/dsh-ops-access`(core) 下的 provider 插件之一。core 拥有 YAML 凭据 registry(`~/.dsh-ops/access.yaml`)和 `ctx.opsAccess` 服务;本包通过 `registerAccessProvider` 贡献两个凭证种类:

- **`ssh` — 主机**:`host`,可选 `user` / `key` / `password` / `port`,以及可选 `cred` — 指向一个 `ssh-cred` 条目的引用。推荐形态是主机 + `cred`;内联 `key`/`password` 继续可用(遗留/一次性场景)。resolve 时 core 把被引用凭证的字段合并到主机条目**之下** — 主机上设的 `user` 覆盖凭证的默认登录用户。
- **`ssh-cred` — 凭证**:可选 `user`(默认登录用户)、`key`、`password` — key/password 至少一个必填。不持有主机,只作为 `cred` 引用的目标被解析。秘密登记一次,N 台主机引用,轮换只改一处。
- **字段处理**:展开 key/password 路径中的 `~`,让 `ssh -i` / `sshpass -f` 拿到绝对路径。
- **保存时校验**:密钥内容先做廉价的 PEM armor 检查,再用 `ssh-keygen -y` 做真实解析(结构看似合法但内容损坏的粘贴会在此刻得到清晰报错,而不是在排查中途撞上 `error in libcrypto`;带口令的密钥也会提前得到 BatchMode 说明)。密码内容必须单行 — `sshpass -f` 只读文件第一行。
- **粘贴内容**:admin UI 收到的是密钥/密码内容(而非路径)时,core 会写入 `~/.dsh-ops/credentials/` 下的 0600 受管文件;两个种类都声明尾随换行规范化(密钥粘贴恰好丢了 END 行末尾换行时,首次使用会在 libcrypto 里失败 — 2026-08-27)。

## 为什么这样拆

三角色规则(见仓库 `AGENTS.md`):core 拥有 registry 和服务,provider 只带一个 zod schema 加字段处理,消费端工具解析 profile 并拼 shell 命令。本包保持 schema + 处理的最小形态,意味着任何服务都不经手秘密材料 — profile 里只有路径和连接参数。

主机/凭证分离用的是 core 的通用 `references` 机制(`references: { cred: 'ssh-cred' }`):一次 resolve 只对**主机条目**咨询一次 broker — 被引用的凭证是实现细节,不是单独门控的 profile。悬挂引用会让引用方的 resolve(及其 `canResolve` 预检)失败,并报出两端条目名。

注册在 `registerAccessProvider` 内部经 `ctx.inject(['opsAccess'], ...)` 延迟挂载,并绑定在插件的 effect 生命周期上,fiber 销毁 / HMR 卸载会把 provider 从 registry 移除。

## 安装

加入 `dsh-web-app` 依赖,并在 ops preset 的 `agent.cordis.yml` 中引用:

```yaml
- id: ops-access-ssh
  name: '@elinpf/dsh-ops-access-ssh'
```

## 配置项

- `validateTimeoutMs`(数字,默认 `5000`)— 保存时 `ssh-keygen -y` 解析的超时时间。

## 测试

```sh
npm run build
npx vitest run
```

测试覆盖:两个种类的 schema 接受/拒绝、`~` 展开、`cred → ssh-cred` 引用声明、合并后用户校验、经 mock `opsAccess` 上下文的注册/销毁(含 HMR 卸载),以及 validateContent 的 armor 闸门 + 真实 `ssh-keygen` 解析 + 密码单行规则(在临时目录生成一次性 ed25519 密钥)。
