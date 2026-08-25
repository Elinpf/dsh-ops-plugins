# 01 — core broker 挂点 + 门骨架与凭证代发

**What to build:** core 能管两个登记文件（access.yaml + access-rw.yaml，同格式同校验纪律），resolve 接受可选的 agent 上下文，并暴露 broker 挂点——一个纯决策函数 `(kind, name, agent) => 'ro' | 'rw' | 拒绝`，无 broker 时系统行为与今天完全一致。新包 `ops-access-gate` 站起来：进程内账本按 session（`agent.id`）分键，注册决策 broker——有授权发 rw、无授权发 ro、`agent` 缺失 fail-closed。ops-shell-tool 把 `exec.agent` 透传进 resolve 链路。授权从哪来不在本票范围（测试里直接注入账本）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] core 新增 rw 登记文件配置与读取，两文件共用同一套校验（零复制）
- [ ] resolve 支持 agent 上下文 + broker 挂点；无 broker 时行为逐字节不变（回归测试）
- [ ] broker 注册走延迟挂载帮手（防 loader 死锁，同 registerAccessProvider 模式）
- [ ] ops-shell-tool 透传 `exec.agent`，ops-tool-* 三个消费方零改动
- [ ] 门账本按 `agent.id` 分键：session A 的授权对 session B 不可见
- [ ] 有授权 → rw 字段；无授权 → ro 字段；`exec.agent` 缺失 → 一律按无授权
- [ ] rw 文件缺失/条目缺失/校验失败的报错不泄露秘密内容
- [ ] 全仓测试绿，门包测试覆盖上述矩阵
