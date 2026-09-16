# @elinpf/dsh-ops-access-hub

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
