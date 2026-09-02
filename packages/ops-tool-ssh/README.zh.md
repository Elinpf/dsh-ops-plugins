# @elinpf/dsh-ops-tool-ssh

DeepSeek Harness 运维模式的 `ssh` 工具 — 使用已注册的 ssh 访问档案在远程主机上执行命令(密钥路径、端口、user@host 自动注入)。

## 功能

ops-access 凭据缝隙的消费方:模型用档案名加命令调用 `ssh`,插件经 `opsAccess` 解析档案,再经 `ctx.shell` 执行。`BatchMode=yes` 让任何需要交互的场景快速失败;`StrictHostKeyChecking=accept-new` 首次连接信任主机密钥、密钥变更则拒绝。可用 `list_access` 查看可选主机名。

- 远程命令作为**一个**单引号参数整体传出 — 管道、重定向、`&&`、`;`、`$()` 全部在远程主机执行,本地 shell 绝不切分这行命令(2026-08-27 险情:一条未加引号的 `&&` 链差一次认证失败就在本地删掉了控制面清单)。
- 只有密钥路径换成按次生成的凭据 token;user@host 和端口保持内联。展示命令(模型可见、入日志)只含 token — 真正执行的命令才带真实值。
- 信号死亡(exitCode 为 null)归一化为 -1,原因写入 `error` 字段。

## 设计

本包刻意保持单薄。所有共享机制 — 结果形状 `{ exitCode, stdout, stderr, command, error? }`、输出 schema、render、按次解析的执行模板(默认 30s 超时)— 都在 `@elinpf/dsh-ops-shell-tool`。消费方工具只提供四个身份要素:工具名、凭据 kind、档案参数名、`buildCommand`。ops-access 缝隙每次调用经 `ctx.get('opsAccess')` 现取,绝不用静态 inject(preset 并发挂载同组插件,静态 inject 会让加载器死锁)。

- `src/index.ts` — 插件本体(函数式插件:`name`/`inject`/`Config`/`apply`,无默认导出)。注册走 `ctx.effect`,fiber 销毁/HMR 时工具随之卸载。
- `src/types.ts` — 纯类型(无任何运行时值)。
- `src/invariant.ts` — invariant 伴随插件;无运行时 invariant(工具无状态,不拥有 session 事件),仅登记包的归属。

## 配置

```yaml
- id: ops-tool-ssh
  name: '@elinpf/dsh-ops-tool-ssh'
  timeoutMs: 30000            # 单次调用的 shell 超时(毫秒)
  connectTimeoutSeconds: 10   # ssh -o ConnectTimeout(TCP 握手等待)
```

## 测试

```sh
npm run build
npx vitest run
```

测试用 mock 上下文(`tests/harness.ts`)挂载插件,捕获工具注册、shell resolve/run 调用和 effect disposer — 覆盖命令拼装、引号、凭据 token、错误兜底、render 纯函数性和 HMR 卸载。
