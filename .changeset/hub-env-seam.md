---
"@elinpf/dsh-ops-access": minor
---

新增 `ACCESS_HUB_URL` 环境变量接缝:未显式配置 `source` 时,设置该环境变量即切换 hub 模式(`hubUrl` 也用它兜底)。动因:preset 落盘文件(`~/.dsh/.agent-presets/ops/agent.cordis.yml`)每次套件升级重装都会被重写,写进去的 hub 配置会被静默冲掉、部署悄悄退回 yaml 模式;而 profile 的 `cordis.patch.yml` 只能打 host 面的补丁,够不到 preset 面的 access core。进程环境变量(systemd unit)是唯一升级不丢的开关。显式 `source: yaml` 仍可压住环境变量。
