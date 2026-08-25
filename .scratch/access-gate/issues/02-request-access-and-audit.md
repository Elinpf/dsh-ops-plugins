# 02 — request_access 申请审批 + ssh 模式 + 审计日志

**What to build:** 人能参与的完整链路。agent 可调 `request_access(profile, reason, ttl?)` 陈述方案向人申请；申请走 dsh 原生审批通道（人看到 profile、理由、时长，可批准/拒绝）；批准入账、拒绝返回原因给 agent；agent 能查看当前会话生效中的授权及剩余时间。ssh kind 无授权时 resolve 拒绝、错误信息指向 request_access；有授权放行限时通行。授权（批准/到期/撤销）与每次 rw 代发逐条写 JSONL 审计日志，字段含时间戳、session id、profile、动作、理由、批准人。

**Blocked by:** 01 — core broker 挂点 + 门骨架与凭证代发

**Status:** ready-for-agent

- [ ] request_access 工具：申请触发原生审批；批准入账；拒绝返回原因；可列出当前生效授权
- [ ] TTL 到期自动回落 ro，正在执行的命令跑完、新调用才回落
- [ ] 可手动撤销，撤销立即生效
- [ ] ssh 无授权 → 拒绝且错误信息指向 request_access；有授权 → 限时放行
- [ ] subagent（独立 session id）不继承主会话授权
- [ ] 审计日志逐条落 JSONL：授权、到期、撤销、rw 代发各一行，字段完整
- [ ] 全仓测试绿，新增测试覆盖批准/拒绝/到期/撤销/ssh 拒绝路径
