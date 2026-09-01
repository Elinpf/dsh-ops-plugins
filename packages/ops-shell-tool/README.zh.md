# @deepseek-ai/dsh-ops-shell-tool

ops-access 消费方工具共享的工厂：统一的 shell 结果形状 `{ exitCode, stdout, stderr, command, error? }`、输出 schema 与 render、以及按调用解析（resolve-per-call）的 execute 模板。

## 功能

纯库（不是插件）——把每个 ops 命令工具（`ops-tool-kubectl`、`ops-tool-ceph`、`ops-tool-ssh`）否则会各自重复的样板收敛到一处。消费方在自己的插件里调用 `registerProfiledShellTool(ctx, spec)`，只保留身份四件套：工具名、解析的 ops-access kind、profile 参数名、`buildCommand`。

- **统一结果形状** — 一份 `ShellToolResult` 定义、一份输出 schema、一份纯 render，所有消费方工具共用。
- **按调用解析** — profile 在 execute 内通过 `ctx.get('opsAccess')` 解析，不做静态 inject，不缓存。
- **凭据 token** — `buildCommand` 用 `ref(field)` 标记含文件的字段，生成展示 token `<id@tier:field>`；实际执行的命令携带 shell 转义后的真实值，而展示命令和捕获的 stdout/stderr 全部洗回 token。凭据路径永远不进入模型上下文或会话事件日志。
- **诚实的 kill 报告** — 默认 30s 超时；信号死亡归一为 `exitCode: -1`，并在 `error` 字段写明原因（超时 / 调用方取消 / 信号名），绝不留一个光秃秃的 -1。
- **stderr 噪音过滤** — 消费方声明的正则在清洗之后丢弃已知噪音行（如 ceph keyring 唠叨）。
- **`shellQuote`** — 导出给需要把整条远端命令作为单个参数嵌入的消费方（ops-tool-ssh）。

## 设计要点

- **为什么是工厂而不是基类插件：** 三个消费方工具只差身份件。execute 模板收在这里，超时处理、kill 说明、凭据清洗只修一处，而不是三处。
- **为什么用 `ctx.get` 按调用解析而不是静态 inject：** preset 并发挂载同组插件，静态 `inject: ['opsAccess']` 有对定义行死锁的风险；到工具调用时服务早已就绪。与 registry 文件同一纪律：按操作解析，什么都不缓存。
- **为什么 token 按调用生成：** token → 真实值的映射只存活于单次 execute 内，凭据路径不可能跨调用、跨会话泄漏。

## 配置项

无 —— 本包没有插件 `Config`。所有行为由消费方通过 `ProfiledShellToolSpec` 参数化：`name`、`kind`、`targetParam`、三段描述文案、`buildCommand`、`timeoutMs`（默认 30000）、`stderrNoise`。

## 测试方式

```sh
npx vitest run
```

测试用 mock ctx 驱动工厂：按调用解析、agent 透传、seam 缺失守卫、错误透传、exitCode 归一、超时/中止/信号三类 kill 说明、凭据 token 替换与清洗、stderr 噪音过滤、render 纯函数性，以及 HMR 卸载（fiber 的 effect disposer 执行后注册的工具随之消失）。
