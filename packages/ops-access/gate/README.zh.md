# @deepseek-ai/dsh-ops-access-gate

DeepSeek Harness 运维模式的按会话凭据代理（credential brokering）与人工审批 — 拥有授权台账，在每次凭据解析时裁决 ro/rw/deny。

## 功能

闸门位于 ops-access 注册表（`@deepseek-ai/dsh-ops-access`）与每一次凭据解析之间：它向该 seam 注册一个**纯决策 broker**——调用会话持有该档案的未过期授权时答 `rw`，否则答 `ro`；无授权访问审批必需类型（ssh）或档案被运维封禁时答 `deny`。

- **`request_access` 工具** — 模型申请限时授权；调用驻留在待决请求队列中，直到人在授权面板里裁决；结果报告实际授予的 TTL（人可下调）。
- **授权面板后端** — 9 条 HTTP 路由（`/ops-access/grants*`、`/ops-access/access-requests*`、`/ops-access/deny|undeny`）加 `/access`、`/access-all` 两个斜杠命令。面板授权与请求授权同形同寿命。
- **审计日志** — 每个请求、裁决、授权、过期、收回、封禁和台账重置都落追加式 JSONL 文件。
- **封禁（lockdown）** — 运维 deny 持久化到 `deniedFile`，重启不丢（重启后悄悄解除的事件冻结不算冻结）。

## 设计要点

- **闸门永远看不到凭据字段。** 类型、档案名、会话 id 就是它的全部世界——密钥材料不可能经授权路径泄漏。
- **按会话键控的台账，惰性过期。** preset 平面实例共享，授权按 `agent.id` 键控；过期授权在首次被查询时驱逐（web 会话没有可靠的结束事件——TTL 是唯一可靠边界）。
- **授权面板就是审批通道**（ADR-0004），不用 dsh 原生审批：原生结果词汇表带不了人调整过的 TTL。无头部署（无 web server）下 `request_access` 快速失败并给出带外指引。
- **types.ts 是纯类型**（零运行时）；`src/invariant.ts` 是 invariant 伴随插件——只预留包归属、不安装任何检查，因为闸门不拥有任何 session 事件形态（其状态是进程内台账加 JSONL 审计文件）。
- **每个注册都是 effect**，因此 fiber 销毁 / HMR 卸载会移除工具、两个命令、全部路由、通知监听器、broker 和 `opsAccessGate` 服务，并把驻留请求按 cancelled 了结。

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `approvalRequiredKinds` | `['ssh']` | 无 ro 层的类型——任何使用都需授权 |
| `defaultTtlMinutes` | `30` | `request_access` 省略 `ttlMinutes` 时的授权时长 |
| `maxTtlMinutes` | `480` | 申请授权时长的上限 |
| `auditFile` | `~/.dsh-ops/audit.log` | JSONL 审计日志路径（`~` 展开） |
| `grantTtlOptions` | `[5, 10, 30]` | 授权面板提供的 TTL 选项 |
| `pendingRequestTimeoutMinutes` | `5` | 驻留请求等待人工裁决的超时（超时自动拒绝） |
| `deniedFile` | `~/.dsh-ops/denied.json` | 持久化封禁状态（重启保留） |

## 测试

```sh
npm run build
npx vitest run
```

测试把闸门与真实的 ops-access core 一起挂载到 mock cordis 上下文（真实临时注册表与审计文件），驱动外部可观察的 seam：resolve 按台账给 ro/rw、`request_access` 驻留直到 decide 路由了结、面板路由直接授权/收回、TTL 过期与通知行为、每次转移都有审计。HMR 卸载套件销毁闸门 fiber 并断言每个注册面（工具、命令、路由、监听器、broker、服务）都被移除，同时 core 保持挂载。
