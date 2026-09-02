# @elinpf/dsh-ops-tool-ceph

DeepSeek Harness 运维模式下的 `ceph` 工具 — 通过 ops-access 接缝按名字解析 Ceph 集群档案(profile),经由 `ctx.shell` 对集群执行 `ceph` / `rbd` / `rados` 命令,凭证路径自动注入。

## 它做什么

模型用 `cluster`(档案名)和 `command` 调用 `ceph` 工具。工具每次调用都重新解析档案(不缓存,凭证改动立即生效),把档案的 `--conf` / `--keyring`(档案带 cephx 用户时还有 `--name`)以 `<id@tier:field>` 令牌引用的形式拼进真实命令行,经 shell 服务以 30 秒超时执行,返回标准结果 `{ exitCode, stdout, stderr, command, error? }`。

## 设计要点

- **薄消费者,共享机制。** 本包只提供四件身份要素:工具名、解析类型(`ceph`)、档案参数名(`cluster`)、`buildCommand`。其余全部(结果形态、输出 schema、渲染、逐次解析的执行模板、超时与信号死亡归一化)都在 `@elinpf/dsh-ops-shell-tool`,保证三个消费工具(`kubectl` / `ceph` / `ssh`)不会各自漂移。
- **首词选二进制。** `rbd` 和 `rados` 是独立二进制,不是 ceph 子命令 — `ceph rbd ls` 只会在 mon 侧报 "no valid command found"。按命令首词在白名单 `[ceph, rbd, rados]` 中选择;裸词视为 ceph 子命令。
- **边界错误优于误导错误。** 跑在宿主机本地的 ceph 生态二进制(`mount.ceph`、`ceph-fuse`、`ceph-volume`、`rbd-nbd` 等)明确不包装;这类调用直接报清晰错误并指向 `ssh` 工具,而不是让 mon 的误导性报错带偏排查。
- **stderr 噪音过滤。** 两条已知的" /etc/ceph 下找不到 keyring "警告(凭证都经注入的 `--keyring` 到达,纯属噪音)按精确模式剔除;其余 stderr 行原样透传。
- **秘密不经过工具。** 档案只携带路径和连接参数;文件路径在拼装命令中变成 `<id@tier:field>` 令牌,cephx 实体名(非秘密)保持内联。只读强制由凭证 caps 在 mon/osd 侧执行,工具本身不做。
- **注册即 effect。** 工具经 `ctx.effect(() => ctx.tools.register(...))` 注册(在 `registerProfiledShellTool` 内部),fiber 销毁 / HMR 时干净卸载。`./invariant` 子路径注册一个空实现的 invariant 伴生插件:本工具无状态、不拥有 session 事件,没有需要安装的运行时不变量。

## 配置项

schemastery schema,仅一项:

| 键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `30000` | 单次 ceph 执行的 shell 超时(毫秒)。慢集群可调大。 |

## 测试方式

```sh
npm run build     # tsc → lib/(插件加载的是 lib/,不是 src/)
npx vitest run    # 基于 mock ctx(shell / tools / opsAccess)的单元测试
```

测试覆盖:命令拼装(ceph / rbd / rados / 显式前缀剥离 / `--name` 注入)、不包装边界、档案解析与 shell 失败映射、stderr 噪音过滤、render 纯函数性、导出形态(`.` / `./invariant` / `./types` 三个入口)、以及 HMR 卸载(执行收集到的全部 effect disposer 后工具被注销)。
