# @elinpf/dsh-ops-access-hub

[English](README.md) | 中文

dsh ops 插件集的独立凭证中心——**不是 dsh 插件**。一个小型、可独立部署的服务：全部 ops-access 凭证存于单一 AES-256-GCM 加密文档，对外提供 token 认证的 HTTP API，附带精简 Web 界面和 YAML 注册表导入器。`@elinpf/dsh-ops-access`（core）可以把它作为凭证来源（`source: 'hub'`）；hub 本身是哑存储——kind schema、校验、能力探针都留在 access 侧。

## 功能

- **加密落盘**：整个数据集是一个 JSON 文档（`<data-dir>/hub-data.json.enc`），AES-256-GCM、每次写随机 nonce、tmp+rename 原子写、0600。master key 来自环境变量 `ACCESS_HUB_KEY`（base64/hex）或 key 文件（默认 `<data-dir>/hub.key`，首启自动生成，0600）。文件类字段存**内容**而非路径。
- **token 认证的 HTTP API**（裸 `node:http`，默认绑 `127.0.0.1:3090`），`crypto.timingSafeEqual` 比较，401/403 区分。两种 Bearer token：
  - **静态 bootstrap token**——admin（全量）与 read（解析、病例写入、申请列表）各一把，来自 CLI flag / env。始终有效、不可吊销：break-glass 路径。
  - **具名 token**（ADR-0009）——用 `POST /tokens`（或 CLI / Web UI）**按人**签发：标签 + 角色 + 可选有效期。明文**只返回一次**，落库只存 SHA-256 摘要；`DELETE /tokens/:id` 按人吊销（终态、立即生效），不影响其他人的凭证。
- **append-only 审计日志**（`<data-dir>/audit.log`，JSONL）：每次成功的 resolve/put/delete 连同 token 角色各记一行——具名 token 还记持有人标签 `actor`，多人使用可归属。永不记字段值。
- **单文件中文 Web UI**（`GET /`）：token 输入（localStorage，经 `/whoami` 显示解析出的角色与标签）、带 probe 徽标的条目列表、新建/编辑/删除、token 名册（签发 + 明文一次性展示 + 吊销）、审计查看（含操作者列）。页面本身不含任何秘密。

## 用法

```sh
dsh-ops-access-hub serve [--port 3090] [--host 127.0.0.1] [--data-dir ~/.dsh-ops-hub] \
  [--key-file <file>] [--admin-token <t>] [--read-token <t>]

dsh-ops-access-hub import <access.yaml> \
  (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]

dsh-ops-access-hub token create --name <name> --role <admin|read> [--expires-at <ISO>] \
  (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
dsh-ops-access-hub token list   (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
dsh-ops-access-hub token revoke --id <id> (--url <hubUrl> --admin-token <token> | --data-dir <dir>) [--key-file <file>]
```

每个 `serve` flag 都有环境变量对应（`ACCESS_HUB_PORT`、`ACCESS_HUB_HOST`、`ACCESS_HUB_DATA_DIR`、`ACCESS_HUB_KEY_FILE`、`ACCESS_HUB_ADMIN_TOKEN`、`ACCESS_HUB_READ_TOKEN`）。未配置的 token 首启随机生成并**只打印一次**。

`import` 把现有 ops-access YAML 注册表搬进 hub：单行且以 `/`、`~/`、`./`、`../` 开头并指向可读文件的字段值替换为文件内容（相对路径相对注册表文件目录解析），其余原样通过。`--url` 在线推送进运行中的 hub，或 `--data-dir` 离线直写数据文件。

`token create` 只打印一次明文——请线下交付持有人，hub 无法再次展示。签发凭证是静态 `--admin-token`（它自己作为 break-glass 继续有效）。

## API 一览

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /health` | 无 | `{ok:true}` |
| `GET /` | 无 | 静态 Web UI |
| `GET /whoami` | read+ | 当前 token 解析结果：`{role,actor,source}` |
| `GET /entries` | read+ | 每条目的 envelope + tier 存在性 + probe——**永不含字段值** |
| `GET /entries/:kind/:name/:tier` | read+ | 单个 tier 的完整 fields（记 `resolve` 审计）；缺失 404 |
| `PUT /entries/:kind/:name/:tier` | admin | upsert `{fields, envelope?, probe?}`；envelope 整体替换 |
| `DELETE /entries/:kind/:name/:tier` | admin | 删除最后一个 tier 时整条删除 |
| `GET /audit?limit=N` | admin | 最近 N 条审计（默认 100，上限 1000） |
| `GET /cases` | read+ | 排错病例索引行——只有元数据，无全文 |
| `GET /cases/:id` | read+ | 单条病例完整记录 |
| `POST /cases` / `PUT /cases/:id` | read+ | 新建/更新病例——**刻意的角色放宽**：病例不含机密，agent 只持 read token |
| `POST /cases/:id/hit` | read+ | 病例命中数 +1 |
| `DELETE /cases/:id` | admin | 删除病例 |
| `POST /tokens` | admin | 签发具名 token `{name,role,expiresAt?}`——**明文只在这个响应里**；活标签重名 409 |
| `GET /tokens` | admin | token 名册，只有元数据——永不含摘要与明文 |
| `DELETE /tokens/:id` | admin | 吊销一个具名 token（终态；404 不存在、409 已吊销） |

## 安全注意

- v1 是明文 HTTP，默认只绑 loopback——远程部署必须把 hub 放在 TLS 反向代理之后。
- hub 是单点：**数据文件和 master key 都要备份**。丢了 key，数据文件无法恢复。
- token 不要进日志和 shell 历史（优先用环境变量注入）；消费方只配 read token，admin token 只给写入方。
- 具名 token 落库的是 SHA-256 摘要而非秘密本身：数据文件（或备份）泄露不会直接交出可用凭证。静态 bootstrap token 是例外——它们活在 env/flag 配置里，是 break-glass 路径，无法通过 API 吊销。

## 测试

```sh
npm run build     # tsc → lib/
npx vitest run    # 加解密往返、key 文件生成与权限、API 鉴权（401/403）、
                  # CRUD、最后-tier 连锁删除、probe 回写、审计追加、import 路径→内容、
                  # 具名 token（签发/一次性明文/角色/吊销/过期/actor 归属）、
                  # Web UI 内联脚本可编译检查
```
