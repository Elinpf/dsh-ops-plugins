# @elinpf/dsh-ops-access-ssh

ops access 接缝的 SSH 凭据 provider — 校验 `ssh` registry 条目(`{ host, user, key?, port? }`)并为 ssh 消费端工具展开密钥路径。

## 功能

`@elinpf/dsh-ops-access`(core) 下的三个 provider 插件之一。core 拥有 YAML 凭据 registry(`~/.dsh-ops/access.yaml`)和 `ctx.opsAccess` 服务;本包通过 `registerAccessProvider` 只贡献一个凭据种类 `ssh`:

- **条目 schema**(zod):`host`、`user`,可选 `key`(私钥路径),可选 `port`
- **字段处理**:展开 key 路径中的 `~`,让 `ssh -i` 拿到绝对路径
- **保存时密钥校验**分两层:先做廉价的 PEM armor 检查,再用 `ssh-keygen -y` 做真实解析 — 结构看似合法但内容损坏的粘贴会在此刻得到清晰报错,而不是在排查中途撞上 `error in libcrypto`;带口令的密钥也会提前得到 BatchMode 说明
- **粘贴密钥内容**:admin UI 收到的是密钥内容(而非路径)时,core 会写入 `~/.dsh-ops/credentials/` 下的受管文件;provider 声明尾随换行规范化(粘贴恰好丢了 END 行末尾换行时,首次使用会在 libcrypto 里失败 — 2026-08-27)

## 为什么这样拆

三角色规则(见仓库 `AGENTS.md`):core 拥有 registry 和服务,provider 只带一个 zod schema 加字段处理,消费端工具解析 profile 并拼 shell 命令。本包保持 schema + 处理的最小形态,意味着任何服务都不经手秘密材料 — profile 里只有路径和连接参数。

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

测试覆盖:schema 接受/拒绝、`~` 展开、经 mock `opsAccess` 上下文的注册/销毁(含 HMR 卸载),以及 validateContent 的 armor 闸门 + 真实 `ssh-keygen` 解析(在临时目录生成一次性 ed25519 密钥)。
