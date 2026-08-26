# ADR-0003: 合并双文件注册表 —— ro/rw 成为条目的 tier 子字段

## 背景

ADR-0001 决策 6 把 ro/rw 拆成两个文件（`access.yaml` + `access-rw.yaml`），理由是 `access.yaml` 对 agent 明文可见、rw 需要另存。凭证管理 UI（ADR-0002）落地后发现两个文件带来了真实的心智成本：同一个凭证要写两遍（ro 一遍、rw 一遍），而两个文件的格式、校验、读取逻辑完全一致——**它们之间没有区别**。

## 决策

合并为单一注册表文件（默认 `~/.dsh-ops/access.yaml`）。ro/rw 不再是文件级分离，而是**条目内的 tier 子字段**：

```yaml
version: 1
k8s:
  prod:
    description: 生产集群
    environment: prod
    ro:
      kubeconfig: ~/.dsh-ops/credentials/k8s/prod/ro/kubeconfig
    rw:
      kubeconfig: ~/.dsh-ops/credentials/k8s/prod/rw/kubeconfig
```

- envelope（description/environment）在条目层，两个 tier 共享
- core 的 `Config.rwRegistryFile` 删除，只留 `registryFile`
- broker 接口不变：`'ro' | 'rw' | { deny }`，core 按裁决取 `entry[tier]`
- `list()`（agent 可见面）只发 `ro` tier
- 凭证内容文件按 tier 独立存放：`~/.dsh-ops/credentials/<kind>/<name>/<tier>/<field>`
- 管理 UI 一个表单同时呈现 ro / rw 两档字段，一次提交写两档，消灭"写两遍"

## 安全面变化

旧模型里 rw 的"不可见"靠的是文件级隔离（agent 的 help 不提 access-rw.yaml）。新模型下 rw 条目与 ro 同文件，agent 若直接读注册表文件能看到 rw 条目的**路径**。这不改变威胁模型结论：

- 威胁模型是"防犯傻不防作恶"，同 UID 同进程的保密本来就显式出范围（ADR-0001）
- 注册表只存路径不存秘密内容；秘密内容在 `credentials/` 目录的文件里，权限同旧模型
- 真正的 rw 控制点从未变过：门（broker）在 resolve 时拒绝无授权的 rw 发放，授权与代发落审计日志

## 被否决的替代

- **保持双文件** —— 已被实践证伪：两个文件格式与纪律完全一致，分离只带来重复录入与双倍维护
- **条目加 `tier: 'ro'|'rw'` 单字段、同名两条** —— YAML mapping 键不可重复，同名两条非法；且 envelope 会重复
