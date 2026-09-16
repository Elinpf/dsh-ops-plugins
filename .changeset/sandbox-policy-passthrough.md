---
"@elinpf/dsh-ops-shell-tool": patch
---

修复沙箱内 ssh 启动失败 (`Couldn't open /dev/null: Permission denied`): 所有 shell 系消费工具 (kubectl/ceph/ssh) 现在像 dsh 自家 bash 工具一样, 把调用会话的 sandbox policy 显式透传给 shell 执行器。此前请求不带 policy, bash-sandbox 回退到 deployment 策略——其 workspace 根是 dsh 进程 cwd (systemd 服务为 `/`), 导致 bwrap 用 `--bind / /` 盖住自建 /dev tmpfs (/dev 设备节点全部 EACCES, ssh 必开的 /dev/null 打不开), 且 workspace-write 退化为整个容器根可写 (越权面)。修复后沙箱根回到会话工作区。confining 执行器挂载但 sandboxPolicy 服务缺失时, 工具响亮报错拒绝执行, 不再静默用错根。
