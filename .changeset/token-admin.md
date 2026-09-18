---
"@elinpf/dsh-ops-access-hub": minor
---

具名 token 的精细化管理面(ADR-0010):管理面从"签发 / 吊销"两个动作扩展为可精细控制的控制面。新增 `PATCH /tokens/:id`(admin)就地编辑活 token 的 `{name?,role?,expiresAt?}`——缺席字段不改、`expiresAt: null`/`''` 清除有效期(回到长期有效),改的是标签/角色/有效期而非秘密(摘要与前缀原样,持有人无需重新配置;角色变更下一个请求即生效);已吊销 409(终态)、未知 id 404、活标签冲突 409、空补丁与非法值 400、过期时间只收未来。状态判定收敛为 `tokenStatus()` 的四态 `active`/`expiring`(≤7 天)/`expired`/`revoked`,CLI 与 Web UI 共用。审计动作新增 `token-update`,审计行新增可选 `changes`(被改动的字段名,非值),`actor` 照旧归属到操作者;与现值一致的无操作补丁不重写文档、不写审计。CLI 新增 `token update --id <id> [--name] [--role] [--expires-at | --clear-expires]`(在线 `--url` / 离线 `--data-dir` 两种落点),`token list` 状态列区分 active/expiring(剩 N 天)/EXPIRED/REVOKED。Web UI 名册升级为控制面:关键字搜索 + 状态/角色筛选 + 计数汇总、到期时间本地化、四态徽标、逐行"编辑"对话框(含"清除有效期")、审计视图显示 changes。静态 bootstrap token 与既有消费者行为零改动;不做用户体系与按 kind/tier 的细粒度 RBAC(边界延续 ADR-0009)。
