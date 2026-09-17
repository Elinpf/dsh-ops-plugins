---
"@elinpf/dsh-ops-access-hub": minor
---

新增具名 token(ADR-0009):hub 的认证从"两把共享静态 token"扩展为"静态 bootstrap + 按人签发的具名 token"。`POST /tokens` 按人签发 `{name,role,expiresAt?}`——明文只在签发响应里出现一次,落库只存 sha256 摘要与前 8 字符前缀;`GET /tokens` 返回名册元数据(永不含摘要/明文);`DELETE /tokens/:id` 按人吊销(终态、立即 401,重名在活记录间唯一、吊销后标签可复用);新增 `GET /whoami` 报告当前 token 的 `{role,actor,source}`。审计行新增可选 `actor`(具名 token 的标签,回答"谁 resolve 的";静态 token 不记,避免假归属),审计动作新增 `token-create`/`token-revoke`。静态 admin/read token 行为不变,继续作为不可吊销的 break-glass。CLI 新增 `token create|list|revoke`(在线 `--url` 或离线 `--data-dir`,与 import 同纪律),Web UI 新增 token 名册区块(签发/一次性明文展示+复制/吊销)与审计操作者列,token 输入框经 `/whoami` 显示解析结果。名册上限 `MAX_TOKENS=200`;`expiresAt` 只收未来时间,到期与吊销同走 401。core/gate 侧零改动。
