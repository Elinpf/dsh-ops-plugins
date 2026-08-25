# 03 — preset 接线 + 真实 session 验证 + 文档收尾

**What to build:** 门接进 ops preset（同步回仓库根的 ops-preset.yml），在 `.dsh-target` 真实环境走完整链路验证：agent 默认只读 → 申请 rw → 人批准 → 执行 rw 命令 → 到期回落；ssh 无申请被拒。为验证准备一套 ro/rw 双账号的测试 profile（k8s 或 ceph）。收尾：CONTEXT.md 审计门一节摘掉"未实现"标记，确认词汇与实现一致。

**Blocked by:** 02 — request_access 申请审批 + ssh 模式 + 审计日志

**Status:** ready-for-agent

- [ ] 门行接入 ops preset，profile 依赖更新，服务重启正常加载
- [ ] 真实 session 验证：默认 ro 可执行只读命令
- [ ] 真实 session 验证：申请 → 批准 → rw 命令执行成功 → 到期后回落 ro
- [ ] 真实 session 验证：ssh 无授权被拒，批准后放行
- [ ] 审计日志文件在真实环境中逐条落行
- [ ] CONTEXT.md 与 ADR-0001 摘"未实现"状态，措辞与实现一致
