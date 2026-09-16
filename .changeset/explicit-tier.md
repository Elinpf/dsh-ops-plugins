---
"@elinpf/dsh-ops-access": patch
"@elinpf/dsh-ops-access-gate": patch
"@elinpf/dsh-ops-shell-tool": patch
"@elinpf/dsh-ops-tool-prometheus": patch
---

access 支持每次调用显式声明凭证档位: 所有 shell 系消费工具(kubectl/ceph/ssh)和 prometheus 工具新增可选 `tier: 'ro'|'rw'` 参数。不传 = 按授权自动决定(现状); 显式 `'ro'` = 主动降级——持有 rw 授权的会话也可以用只读凭证执行纯查询, 授权不受影响也不记 rw-issue 审计; 显式 `'rw'` = 要求写档, 未授权时响亮报错并指引 request_access(不再静默给 ro)。对 approval-required 的 kind(ssh, 凭证只有一份)显式要 rw 会得到明确的"无 rw 档"教学错误。core 的 `resolve` 新增第 4 参 `AccessRequest`; 无 gate 时显式 rw 直接抛错(rw 永不在无 broker 时签发)。
