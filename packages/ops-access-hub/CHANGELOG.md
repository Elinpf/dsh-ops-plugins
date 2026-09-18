# @elinpf/dsh-ops-access-hub

## 0.4.0

### Minor Changes

- 24f332c: 新增具名 token(ADR-0009):hub 的认证从"两把共享静态 token"扩展为"静态 bootstrap + 按人签发的具名 token"。`POST /tokens` 按人签发 `{name,role,expiresAt?}`——明文只在签发响应里出现一次,落库只存 sha256 摘要与前 8 字符前缀;`GET /tokens` 返回名册元数据(永不含摘要/明文);`DELETE /tokens/:id` 按人吊销(终态、立即 401,重名在活记录间唯一、吊销后标签可复用);新增 `GET /whoami` 报告当前 token 的 `{role,actor,source}`。审计行新增可选 `actor`(具名 token 的标签,回答"谁 resolve 的";静态 token 不记,避免假归属),审计动作新增 `token-create`/`token-revoke`。静态 admin/read token 行为不变,继续作为不可吊销的 break-glass。CLI 新增 `token create|list|revoke`(在线 `--url` 或离线 `--data-dir`,与 import 同纪律),Web UI 新增 token 名册区块(签发/一次性明文展示+复制/吊销)与审计操作者列,token 输入框经 `/whoami` 显示解析结果。名册上限 `MAX_TOKENS=200`;`expiresAt` 只收未来时间,到期与吊销同走 401。core/gate 侧零改动。
- 7c41f3a: 具名 token 的精细化管理面(ADR-0010):管理面从"签发 / 吊销"两个动作扩展为可精细控制的控制面。新增 `PATCH /tokens/:id`(admin)就地编辑活 token 的 `{name?,role?,expiresAt?}`——缺席字段不改、`expiresAt: null`/`''` 清除有效期(回到长期有效),改的是标签/角色/有效期而非秘密(摘要与前缀原样,持有人无需重新配置;角色变更下一个请求即生效);已吊销 409(终态)、未知 id 404、活标签冲突 409、空补丁与非法值 400、过期时间只收未来。状态判定收敛为 `tokenStatus()` 的四态 `active`/`expiring`(≤7 天)/`expired`/`revoked`,CLI 与 Web UI 共用。审计动作新增 `token-update`,审计行新增可选 `changes`(被改动的字段名,非值),`actor` 照旧归属到操作者;与现值一致的无操作补丁不重写文档、不写审计。CLI 新增 `token update --id <id> [--name] [--role] [--expires-at | --clear-expires]`(在线 `--url` / 离线 `--data-dir` 两种落点),`token list` 状态列区分 active/expiring(剩 N 天)/EXPIRED/REVOKED。Web UI 名册升级为控制面:关键字搜索 + 状态/角色筛选 + 计数汇总、到期时间本地化、四态徽标、逐行"编辑"对话框(含"清除有效期")、审计视图显示 changes。静态 bootstrap token 与既有消费者行为零改动;不做用户体系与按 kind/tier 的细粒度 RBAC(边界延续 ADR-0009)。

## 0.3.0

### Minor Changes

- 1015b6b: 新增排错知识库 `/cases` 路由:`GET /cases`(索引行, 无全文)、`GET /cases/:id`、`POST /cases`、`PUT /cases/:id`、`POST /cases/:id/hit`(read+ 均可 — 刻意的角色放宽, 病例不含机密, agent 只持有 read token)、`DELETE /cases/:id`(admin)。病例模型: title/symptoms/rootCause/fix + 可选 evidence/methodology(怎么查出来的, 供相似场景复用方法)/difficulty(1-5 自评难度)/tags/environment。store 侧:`cases` 文档段(随整文档加密落盘)、CRUD/hit 方法、`MAX_CASES=500` 上限、32KB 单条上限、case 动作审计(只记 id+title)。消费方是新包 `@elinpf/dsh-ops-knowledge`。

### Patch Changes

- c55b0ae: 离线导入(`import --data-dir`)补上 kind/name 字符集校验:此前 `applyToStore` 直写 store,绕过了 HTTP 面的 `NAME_PATTERN` 校验,手改的注册表可以把 API 既无法 resolve 也无法删除的脏条目写进 hub。`NAME_PATTERN` 移至 store 模块,HTTP 面与导入面共用同一份。

## 0.2.0

### Minor Changes

- 5c1fc5f: Add the registration-request approval queue (ADR-0008). Agents can now submit tier-registration requests that take effect only after human approval: `POST /requests` queues `{kind,name,tier,fields,envelope?,reason?}` (audited as `request`), `GET /requests?status=` lists metadata only (field names + byte sizes, never values), `GET /requests/:id` returns full field values for pre-approval review (admin only), and `POST /requests/:id/decide` approves (the tier is written) or rejects (audited as `approve`/`reject`). Requests persist in the encrypted document; a decided request's `fields` are wiped immediately so secret material never lingers in a settled record.

### Patch Changes

- 5c1fc5f: Harden store durability and audit-log resilience. `save()` now uses a unique tmp name per write (concurrent saves can no longer collide on `tmp-{pid}-{ms}`), fsyncs the payload before the atomic rename, and fsyncs the directory after it — a power cut cannot leave a torn or zero-length data file. `audit()` detects a torn tail line (crash mid-append) and starts a fresh line instead of fusing the next record onto it; `readAudit()` skips unparseable lines instead of throwing on every future read.
