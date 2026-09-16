---
"@elinpf/dsh-ops-access-hub": minor
---

新增排错知识库 `/cases` 路由:`GET /cases`(索引行, 无全文)、`GET /cases/:id`、`POST /cases`、`PUT /cases/:id`、`POST /cases/:id/hit`(read+ 均可 — 刻意的角色放宽, 病例不含机密, agent 只持有 read token)、`DELETE /cases/:id`(admin)。病例模型: title/symptoms/rootCause/fix + 可选 evidence/methodology(怎么查出来的, 供相似场景复用方法)/difficulty(1-5 自评难度)/tags/environment。store 侧:`cases` 文档段(随整文档加密落盘)、CRUD/hit 方法、`MAX_CASES=500` 上限、32KB 单条上限、case 动作审计(只记 id+title)。消费方是新包 `@elinpf/dsh-ops-knowledge`。
