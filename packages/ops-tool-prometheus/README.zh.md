# @elinpf/dsh-ops-tool-prometheus

DeepSeek Harness 运维模式下的 `prometheus` 工具 — 通过 ops-access 接缝按名字解析 `prometheus` 档案(profile),直接对 Prometheus HTTP API(`/api/v1/query` / `/api/v1/query_range`)执行 PromQL 查询,bearer token 自动注入。不走 shell,不写 curl heredoc。

## 它做什么

模型用 `cluster`(档案名)和 `query`(PromQL)调用 `prometheus` 工具。不带时间参数 = 当前时刻的 instant 查询;`time`(RFC3339 或 unix 秒)固定 instant 时刻;`start`+`end`+`step` 三个都给 = range 查询。工具每次调用都重新解析档案(不缓存,凭证改动立即生效),读取可选的 bearer-token 文件,以 30 秒超时发请求(`timeoutSec` 可单次覆盖,1–600 秒),返回套件标准结果 `{ exitCode, stdout, stderr, command, error? }`。

## 设计要点

- **走 HTTP,不走 shell。** Prometheus API 就是一次 URL 编码的 GET——经 `ctx.shell` + curl 只会引入引号 bug(本工具的动机:一次真实排查会话手写了约 15 次 curl heredoc,写错 5 次)。结果形态、输出 schema、render 逐字复刻 `@elinpf/dsh-ops-shell-tool` 的契约,保证消费工具不各自漂移。
- **失败分级。** PromQL 被拒(API 信封里 `status: "error"`)是服务器的回答:`exitCode: 1`,stderr 放 `errorType: error`。传输层失败——连接被拒、超时(`AbortSignal.timeout`)、调用方中止、非 Prometheus 的 HTTP 状态——一律 `exitCode: -1`,`error` 写明首因,永不裸 -1。
- **秘密不经过工具。** token 只出现在 `Authorization` 头里,永不进日志或回显;所有返回字符串额外按 token 值做防御性擦除。服务器 URL 是普通连接参数,会出现在展示命令里(`prometheus <cluster> query='...' @ http://host:9090/api/v1/query`),让 agent 能确认打到哪个实例。token 文件读取失败的报错不带路径——凭证路径永不进模型视野。
- **大小护栏。** range 结果最多 100 个 series(超出省略并注明)、每 series 50 个点(均匀抽样、首尾必留、头部注明)、stdout ~100KB(截断并注明,指路更窄的选择器/更大的 step)。
- **注册即 effect。** 工具经 `ctx.effect(() => ctx.tools.register(...))` 注册,fiber 销毁 / HMR 时干净卸载。`./invariant` 子路径注册一个空实现的 invariant 伴生插件:本工具无状态、不拥有 session 事件。

## 配置项

schemastery schema,仅一项:

| 键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `30000` | 单次 Prometheus 查询的 HTTP 超时(毫秒)。慢查询可调大。 |

## 测试方式

```sh
npm run build     # tsc → lib/(插件加载的是 lib/,不是 src/)
npx vitest run    # 基于 mock ctx + 注入的 fake fetch 的单元测试,不碰网络
```

测试覆盖:instant/range 路由与 URL 编码、参数形状拒绝(time 与 start/end/step 互斥、range 三缺一)、bearer token 注入与擦除、Prometheus/HTTP/网络/超时失败映射、series/点数/字节三级大小护栏、render 纯函数性、导出形态(`.` / `./invariant` / `./types` 三个入口)、以及 HMR 卸载。
