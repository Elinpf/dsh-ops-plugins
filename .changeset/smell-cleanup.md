---
"@elinpf/dsh-ops-access": patch
"@elinpf/dsh-ops-access-ssh": patch
"@elinpf/dsh-ops-access-prometheus": patch
"@elinpf/dsh-ops-access-ui": patch
"@elinpf/dsh-ops-shell-tool": patch
"@elinpf/dsh-ops-tool-prometheus": patch
---

内部去重清理(code-review 坏味项,无行为变化):expandHome 归位 core/backend.ts(消除 hub-backend 重复实现);单行粘贴守卫提取为 core 导出的 hasSingleLineBody(ssh/prometheus 两 provider 共用);ops-shell-tool 导出 shellToolOutput 契约,ops-tool-prometheus 复用替代逐字拷贝;hub-backend.listRequests 去掉从未使用的 status 参数;access-ui badge 的 pendingRequestCount 内联。另新增私有 test-support 包,合并三份逐字相同的 tests/tmpdir.ts。
