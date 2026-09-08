---
title: access-hub（ops-access-hub + core 双后端）— 集中凭证平台
status: implemented
date: 2026-09-04
adr: docs/adr/0005-access-hub.md
---

# access-hub Spec

## Problem Statement

凭证分散在各 dsh 宿主的本地 `access.yaml` + credentials 目录：多机部署逐台同步、轮换逐台改、无集中视图。ADR-0001 决策 8 预留了中心服务方向，本 spec 定义其实现：独立部署的 access-hub 服务 + core 的双后端抽象。

## Solution

- **新包 `packages/ops-access-hub`**（`@elinpf/dsh-ops-access-hub`，独立版本，首发 0.1.0）：可独立部署的集中凭证管理服务。仓库唯一"非 dsh 插件"例外包（无 cordis.patch.yml、不进 preset、package.json 无 `dsh` 字段、不进 changesets fixed 组）。加密存储 + 双 token REST API + 单文件 Web UI + YAML registry 导入器。依赖底线：`yaml` 一个包；HTTP 用裸 `node:http`。
- **core（`@elinpf/dsh-ops-access`）改双后端**：内部 `AccessBackend` 缝，`YamlBackend` 收编原 YAML 逻辑（默认，行为逐字节不变），`HubBackend` 按需直取 hub 并物化。Config 新增四个可选字段，默认行为完全不变。

## core 侧：AccessBackend 接口契约

内部缝（`src/backend.ts`，不作为公共 API 导出）。core 的 `OpsAccess` handle 拥有全部策略（broker 裁决、provider schema 校验、envelope 合并、probe），backend 只做原始条目持久化。

```ts
interface AccessBackend {
  /** 错误消息里的来源标签（yaml: `registry file <path>`；hub: `access hub at <url>`） */
  readonly label: string
  /** fields-free 列表：envelope + tier 存在性 + probe。来源缺失给空表；来源不可读/损坏抛错 */
  listEntries(): Promise<Array<{ kind, name, envelope, tiers: { ro?: { probe? }, rw?: { probe? } } }>>
  /** 一个 tier 的 provider 形态 fields（fileField 为本地路径）+ envelope + probe；null = 条目或 tier 不存在。
      materialize（默认 true）只对 hub 有意义：true 落盘物化；false 只替换将然路径不落盘 */
  loadTier(kind, name, tier: 'ro'|'rw', opts?: { materialize?: boolean }): Promise<{ fields, envelope, probe? } | null>
  /** 持久化一个 tier。fields 为 provider 形态（fileField 为本地路径——hub backend 读内容上传，路径不出本机）。
      envelope 走补丁纪律（undefined 保留、'' 删除）。probe 随 tier 存储 */
  putTier(kind, name, tier, fields, envelope: EntryEnvelope | undefined, probe?): Promise<void>
  /** 删一个 tier。返回 'missing'（条目不存在）/ 'tier'（条目存活）/ 'entry'（最后 tier 没了整条删） */
  deleteTier(kind, name, tier): Promise<'missing' | 'tier' | 'entry'>
}
```

- 两种 backend 说同一种 provider 形态语言：`fields` 里 fileField 是**本地路径**，envelope（`name`/`description`/`environment`）按条目存，`probe` 挂 tier 旁。内容 ↔ 路径的转换只发生在 HubBackend 边界。
- **无缓存**：HubBackend 每次调用打 hub，对齐 YamlBackend 每次重读文件的纪律。
- YamlBackend 保留未注册 kind 的 section 原样不动（既有行为）。

## hub 侧：HTTP API 契约

默认绑定 `127.0.0.1:3090`。所有错误响应为 JSON `{ok:false,error}`，`error` 永不含字段值。

| 端点 | 鉴权 | 请求 | 响应 |
|---|---|---|---|
| `GET /health` | 无 | — | `{ok:true}` |
| `GET /` | 无 | — | 单文件中文 Web UI（静态壳，本身不含秘密） |
| `GET /entries` | read+ | — | `[{kind,name,envelope,tiers:{ro?:{probe?},rw?:{probe?}},updatedAt}]` —— **永不含字段值** |
| `GET /entries/:kind/:name/:tier` | read+ | — | `{kind,name,tier,fields,envelope,probe?}`；条目或 tier 缺失 404。记 `resolve` 审计 |
| `PUT /entries/:kind/:name/:tier` | admin | `{fields,envelope?,probe?}`（body 上限 4 MiB） | `{ok:true}`。upsert；envelope 给了就**整体替换**（access 侧已做合并）；probe 随 tier 存 |
| `DELETE /entries/:kind/:name/:tier` | admin | — | `{ok:true}` / 404；最后一个 tier 删除时整条删除 |
| `GET /audit?limit=N` | admin | — | 最近 N 条审计，默认 100、上限 1000，旧在前 |

- **kind/name 字符集**：`/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/`（与 access 侧 profile id 规则同源）；tier 只收 `ro`/`rw`。
- **认证**：`Authorization: Bearer <token>`，双 token——admin（全部端点）与 read（仅 `GET /entries*`）。`crypto.timingSafeEqual` 比较；无/错 token 401，read token 触管理端点 403。token 来自 CLI flag 或 env（`ACCESS_HUB_ADMIN_TOKEN` / `ACCESS_HUB_READ_TOKEN`）；未配置的首启生成随机 token 并打印一次，无找回途径。
- **审计**：append-only JSONL `<data-dir>/audit.log`（0600），每行 `{ts,role,action,kind,name,tier}`，action ∈ `resolve|put|delete`，只记成功操作，**永不记字段值**。

## 数据模型与加密存储

整个数据集是单一 JSON 文档 `<data-dir>/hub-data.json.enc`（条目量级几十，载入内存、每次变更整篇重加密；明文不落盘）：

```json
{ "version": 1, "entries": { "k8s/prod": {
    "kind": "k8s", "name": "prod",
    "envelope": { "name": "...", "description": "...", "environment": "prod" },
    "tiers": { "ro": { "fields": { ... }, "probe": { ... } }, "rw": { "fields": { ... } } },
    "updatedAt": "<ISO>" } } }
```

- **fileField 存内容不存路径**；hub 是哑存储，不做 kind schema 校验（schema 权威在 provider 侧）。
- **加密**：AES-256-GCM，每次写随机 12 字节 nonce；落盘是 base64 的 JSON `{nonce,data}`（data = 密文 || 16 字节 GCM tag——文本容器，可检视、过文本工具不炸）。写盘 tmp+rename 原子写，0600。
- **master key**（32 字节）按优先级：env `ACCESS_HUB_KEY`（64 位 hex 优先判定，其次 base64）→ key 文件（默认 `<data-dir>/hub.key`，base64，首启自动生成，0600）。

## core 侧：物化规则（HubBackend）

- `loadTier`（resolve 路径，`materialize: true`）：GET tier → 对 provider 声明的每个 `fileFields`，内容非空字符串则写 `credentialsDir/<kind>/<name>/<tier>/<field>`（0600、tmp+rename 原子写、**内容相同跳过**不刷 mtime），fields 值替换为该本地路径 → 之后照旧过 provider schema/process。空字符串 fileField 跳过（保持删除语义）。
- `loadTier`（`materialize: false`，canResolve/list/getEntry）：只把值替换为**将然的**受管路径，零磁盘写——门批准前的预检等元数据读不落秘密文件。
- `putTier`：对 fileField 读本地受管文件内容上传（读不到则失败 loud——hub 上留半份凭证不如不写）；路径永不出本机。
- `deleteTier`：DELETE 后重新 list 判断整条是否连带删除，决定本地受管目录的清理范围。
- 每次调用都打 hub；404 → null，其余失败带 hub 的错误消息抛出（hub 错误不含字段值）；token 走 Authorization 头，不进错误文本、不进日志。
- 引用展开（ADR-0007 的 `references`）对被引用条目也走 `loadTier`：hub 模式下被引用凭证（如 ssh-cred）的内容在展开时抓取+物化，`materialize` 标志随调用方传递——resolve 展开即物化，canResolve/list 展开只拿将然路径。

## envelope 合并语义

两来源一致（共享 `applyEnvelopePatch` / `mergeEnvelope`）：写入方给的 envelope 按补丁语义合并——字段 `undefined` = 保留现值，`''` = 删除该字段，其他 = 覆盖。hub 的 PUT 是 envelope 整体替换，因此 HubBackend.putTier 先经 fields-free 列表取现 envelope、合并后再上传。三个键以外的一律丢弃（服务端同样只收 `name`/`description`/`environment` 三个字符串键）。

## core Config 字段表

全部可选，默认行为与改动前完全一致：

| 字段 | 默认 | 说明 |
|---|---|---|
| `source` | `'yaml'` | `'yaml'` 读本地注册表；`'hub'` 从 access-hub 按需直取 |
| `hubUrl` | `''` | hub 基地址（如 `http://127.0.0.1:3090`）；`source: 'hub'` 时必填，缺失启动即报错 |
| `hubToken` | `''` | read token（resolve/list）；env 回退 `ACCESS_HUB_READ_TOKEN`。不进日志 |
| `hubAdminToken` | `''` | admin token（写/删）；env 回退 `ACCESS_HUB_ADMIN_TOKEN`。不进日志 |

既有字段（`registryFile`、`credentialsDir`）语义不变；hub 模式下 `registryFile` 不再使用，`credentialsDir` 是物化落点。

## CLI 契约（`dsh-ops-access-hub` bin）

- **`serve`**：flag / env / 默认——`--port` `ACCESS_HUB_PORT` `3090`；`--host` `ACCESS_HUB_HOST` `127.0.0.1`；`--data-dir` `ACCESS_HUB_DATA_DIR` `~/.dsh-ops-hub`；`--key-file` `ACCESS_HUB_KEY_FILE` `<data-dir>/hub.key`；`--admin-token` / `--read-token`（env 同上，未配置首启生成打印一次）。
- **`import <access.yaml>`**：把现有 YAML registry 搬进 hub。转换规则——tier 内**单行**且以 `/`、`~/`、`./`、`../` 开头的字段值视为路径，指向可读文件则替换为文件内容（`./`/`../` 相对 registry 文件目录，`~` 展开 $HOME）；路径形态但读不到 → 报错点名条目与字段、中止导入；其余值原样通过。落点二选一：`--url` + `--admin-token` 在线推送（每 tier 一个 PUT），或 `--data-dir` 离线直写数据文件（需要 master key；与 `--url` 互斥）。结束打印统计（条目/tier/内联文件字段数）。
- 手搓极简 argv 解析（`--flag value` / `--flag=value`），不引 commander 系——依赖底线。

## Web UI

`GET /` 单文件中文界面（内联 vanilla JS，无构建链）：token 输入（存 localStorage）、条目列表（envelope + tier 存在性 + probe 徽标）、新建/编辑/删除（envelope + fields JSON 编辑）、审计查看。无鉴权静态壳——所有数据请求都带 token。

## TLS 与部署

v1 明文 HTTP，默认只绑 loopback。远程部署套 TLS 反向代理（终结不做进 hub 本身）。hub 是单点：**数据文件 + master key 都要备份**；yaml 来源随时可切回作为应急回退。

## Testing Decisions

- hub 包单测：加解密往返、key 文件首启生成与 0600、API 鉴权（401/403）、CRUD、最后-tier 连锁删除、probe 回写、审计追加、import 路径→内容转换。
- core 单测：HubBackend 用 mock fetch（resolve 物化的路径/权限/内容相同不重写、putTier 读文件上传、listEntries、deleteTier、envelope 合并）；既有 `ops-access.spec.ts` 全部不动通过（yaml 回归，125 个测试）。
- behavioral 验证：`.dsh-target` 把 core 配为 hub 模式，本机起 hub，走 `import` → @ 提及 resolve → kubectl/ssh → gate ro/rw 申请流 → register_access / admin UI 写删 → 审计落行；再切回 yaml 验证回归（票 0004）。

## Out of Scope

- TLS 终结、多用户/RBAC、短期凭证签发、HA（ADR-0005「明确不做」）
- kind schema 校验进 hub（哑存储是刻意的）
- 按 tier 拆分来源（ro 本地 / rw 上收）
