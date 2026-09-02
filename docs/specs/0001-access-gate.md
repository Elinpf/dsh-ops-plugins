---
title: 审计门（ops-access-gate）— 按会话的凭证代发与授权
status: implemented
date: 2026-08-25
adr: docs/adr/0001-access-gate.md
---

# 审计门（Access Gate）Spec

## Problem Statement

ops 模式下，agent 默认拿着 `access.yaml` 里登记的全部凭证的全部权限。一次误判、一次错误的命令生成，就直接打在真实生产环境上——人没有任何介入点，事后也查不到"当时是谁放行的、放了什么"。凭证体系目前是"有门的房子但门从不上锁"。

## Solution

给凭证体系装上门：新插件 **ops-access-gate**。

- agent 默认只拿 **ro（只读）凭证**——ro 的只读性由基础设施自己强制（k8s RBAC、ceph cephx caps），这是硬底座
- 需要写权限时，agent 先说明要做什么、为什么，调 `request_access` 向人申请；**人一次性批准**（不是每条命令批一次）
- 批准 = 授权账本入账 `{session, profile, tier, 到期时间, 批准人, 理由}`，该 session 对这个 profile 的后续调用自动换发 **rw 凭证**
- **TTL 到期自动回落** ro；人可随时撤销；dsh 重启账本清空（授权本来就短命，可接受）
- ssh 无真只读账号，**每次使用都要审批**，审批给限时通行
- 每次授权、每次 rw 执行都落审计日志

## User Stories

1. 作为运维工程师，我希望 agent 默认只能对生产环境执行只读操作，这样它的误判断不会造成破坏。
2. 作为运维工程师，我希望 agent 需要写权限时必须向我说明用途并等我批准，这样关键动作前我有决策点。
3. 作为运维工程师，我希望批准一次就放行整个方案的所需权限，而不是每条命令点一次，这样我不会审批疲劳。
4. 作为运维工程师，我希望授权有时限、到期自动收回，这样我不用记着去撤销。
5. 作为运维工程师，我希望能随时手动撤销一个进行中的授权，这样发现不对劲能立刻止损。
6. 作为运维工程师，我希望授权只对我当前这个会话生效，这样别的会话（包括定时巡检）搭不上便车。
7. 作为运维工程师，我希望子 agent（subagent）不继承主会话的授权，这样权限边界清晰。
8. 作为运维工程师，我希望 ssh 登录每次都要我批准，因为 shell 没有只读可言。
9. 作为运维工程师，我希望批准后执行命令时不用再做任何操作（凭证自动换发），这样流程不打断排查思路。
10. 作为运维工程师，我希望被拒绝的请求有明确的原因返回给 agent（"未授权，请先 request_access"），这样 agent 知道下一步是申请而不是重试。
11. 作为审计者，我希望每次授权（谁、哪个 profile、什么理由、多久）都有日志，这样事后可追溯。
12. 作为审计者，我希望每次 rw 凭证的实际执行都有日志，这样能看到授权被用来做了什么。
13. 作为管理员，我希望 rw 凭证不放在 agent 可读的 access.yaml 里，这样 agent 的上下文和日志里永远不会出现 rw 凭证的路径线索。
14. 作为管理员，我希望 rw 凭证文件的格式和 access.yaml 一致、用同一套 provider schema 校验，这样心智成本和代码都不翻倍。
15. 作为管理员，我希望改完 rw 凭证文件立即生效（现读现校验不缓存），和 access.yaml 的纪律一致。
16. 作为插件开发者，我希望门是独立包，core 保持纯粹（只管档案读取），这样职责不混。
17. 作为插件开发者，我希望没有门插件时系统行为和今天完全一样（ro 直发），这样门是可拔插的增强而非硬依赖。
18. 作为运维工程师，我希望系统内部调用（非 agent 发起的工具调用）一律按无授权处理（fail-closed），这样没有侧门。
19. 作为运维工程师，我希望授权到期时正在执行的命令能跑完、新命令才回落，这样不会把长任务砍在半截。
20. 作为运维工程师，我希望能查看当前会话有哪些生效中的授权和剩余时间，这样掌控感是实的。

## Implementation Decisions

- **新包 `ops-access-gate`**（preset 平面，npm 名 `@elinpf/dsh-ops-access-gate`），收在 `packages/ops-access/` 大文件夹旁边或其中（动工时按现有布局惯例定）。core（ops-access/core）保持 dumb。
- **rw 凭证也归 core 管**：~~core 的 Config 增加 `rwRegistryFile`~~（ADR-0003 已合并双文件）——ro/rw 是条目内的 tier 子字段，同一注册表文件、同一套 provider schema 校验、同样现读现校验不缓存。**校验与读取逻辑零复制**——就是 core 现有机器读同一个文件的不同 tier。
- **broker 是纯决策函数，门不碰凭证内容**：core 暴露 broker 挂点，门注册一个 `(kind, name, agent) => 'ro' | 'rw' | 拒绝` 的决策函数；core 依据决定从自己管的对应文件发档案。**门的世界里只有 kind、profile 名、session id、TTL——策略层从头到尾看不见凭证字段**，延续"秘密不过服务的手"的纪律。注册走 `registerAccessBroker(ctx, broker)` 帮手（与 `registerAccessProvider` 同款 `ctx.inject` 延迟挂载，防 loader 死锁）；无 broker 时 resolve 行为与今天完全一致。
- **凭证代发点在 resolve**：ops-shell-tool 的 execute 把 `exec.agent` 传入 resolve 链路（工具工厂一处改动）；core 的 resolve 增加可选的 agent 上下文参数。broker 决定 'rw' → 从 rw 文件发；'ro' 或无 broker → 从 access.yaml 发；拒绝 → 报错并提示走 request_access（ssh kind 无授权走这条路）。
- **新模型工具 `request_access`**（由门注册）：参数 `{ profile, reason, ttl? }`。触发 dsh 原生审批通道（人看到 profile、理由、时长，批准/拒绝）。批准即入账。**agent 显式申请**是流程入口——这实现"先出方案、统一给权限"，pre-execute 逐调用 ask 的模式不采用（审批疲劳）。
- **账本形态**：进程内 `Map<SessionId, grants>` 或 `WeakMap<Agent, …>` 分键（遵循 dsh preset 平面共享实例的纪律）；不持久化——重启即清空，授权短命语义下可接受。grant 含批准人与理由。subagent 有独立 session id，天然不继承。
- **fail-closed**：`exec.agent` 缺失（系统内部调用）一律按无授权。
- **ssh 模式**：ssh 档案照常登记在 access.yaml，但 broker 对 ssh kind 一律要求有效授权才放行 resolve——授权本身就是"限时通行证"，不区分 ro/rw。
- **审计日志**：授权（grant/expire/revoke）与 rw 代发写独立日志文件（如 `~/.dsh-ops/audit.log`，JSONL，一行一事），不进 session 事件流（避免模型可见面膨胀）；具体格式实现时定，字段至少含时间戳、session id、profile、动作、理由、批准人。
- **ADR-0001 修订**：决策 5 中"门挂 tools/pre-execute 做 ask"细化为"显式 request_access + resolve 时代发"；账本键、`agent.id === session.id`、fail-closed 结论不变。实现时同步修订 ADR 与 CONTEXT.md 对应段落。
- **环境标签（environment）**暂不参与裁决逻辑，保留为展示与审计信息（二期策略的输入）。

## Testing Decisions

- **唯一测试缝 = 门插件的事件/服务面**：mock context 挂载门（仿 `ops-access/core/tests/harness.ts` 的现有写法），从缝外驱动，断言 externally observable 的行为——resolve 发的是 ro 还是 rw、ssh 是否被拒、request_access 的批准/拒绝路径、账本状态。不测内部实现细节。
- **测试矩阵**：
  - 无 broker 挂载时 core resolve 行为不变（回归）
  - 无授权 → ro；有授权 → rw 字段来自 rw 文件而非 access.yaml
  - ssh 无授权 → 拒绝且错误信息指向 request_access
  - 授权按 session 隔离：session A 的授权对 session B 不可见
  - `exec.agent === undefined` → fail-closed
  - TTL 到期 → 回落 ro；手动撤销 → 立即回落
  - rw 文件缺失/条目缺失/schema 校验失败 → 报错不含秘密内容
  - 审计日志随授权与代发各写一行
- **behavioral 验证**：`.dsh-target` 真实 session 走完整链路（申请 → 批准 → 执行 rw 命令 → 到期回落），单测替代不了，对齐仓库现有工作流。

## Out of Scope

- 中心凭证服务、Vault/OpenBao、双人审批、break-glass（全部二期）
- ssh CA 短证书（二期；一期发现成 key + 审批）
- 动词级细粒度权限、命令字符串分类（ADR-0001 已否决）
- 防主动作恶的建设（威胁模型 A）
- 审批的自定义 UI（用 dsh 原生审批通道）
- environment 标签参与裁决策略

## Further Notes

- 用户故事 20（查看当前授权）可以做成 `request_access` 工具的 `list` 动作或 `list_access` 的扩展，实现时挑侵入小的。
- dsh 原生审批通道的具体机制（`ask` 裁决 / approval 交互 API）实现前去 dsh 源码确认形状，参考 `docs/interaction` 相关文档。
- 设计推演全过程见 ADR-0001；词汇以 CONTEXT.md "审计门" 一节为准。

## 后续方向（架构走查 2026-08-25 记录，未定案）

- **ro/rw 分档只是存放位置，无机制核验凭证的真实权限**——一个 admin 凭证躺进 ro 档就是默认全权限，门对此不可见。候选方向：provider 可选实现能力探针（k8s 用 `auth can-i` 自检，ceph/ssh 未必可行），或登记时人工声明 + 展示。下次架构走查若重提，先读这条。
- **凭证管理没有 webui**——目前全部靠手编 YAML。候选方向：登记文件的浏览/校验界面（@ 菜单的候选路由 `/ops-access/list` 已是现成数据源），审批面板二期再谈。

## 基础设施侧待办（2026-08-27 实战排查暴露；2026-08-28 已补齐，票 14）

- ✅ **k8s ro 档补 `pods/portforward` create**——新建补充 ClusterRole/Binding `pf-test-cluster-ro-extra`（内置 view 不动）；删绑定实测 forbidden、恢复后 port-forward 读 Prometheus `/api/v1/targets` 200，因果闭环。注：`kubectl auth can-i create pods/portforward` 对该子资源误报 no（SSRR --list 显示正确），以功能实测为准。该补充角色 2026-08-28 又随票 15 增补 `ceph.rook.io` 的 cephclusters/cephblockpools 读取（ro 实测通过）。
- ✅ **k8s ro 档补 PV(persistentvolumes）读取**——同一补充 ClusterRole（get/list/watch），ro 实测 `kubectl get pv` 正常列出。
- ✅ **ceph ro 档补 `class-read`**——`auth caps client.pf-test-cluster-ro mon 'allow r' osd 'allow r class-read' mds 'allow r' mgr 'allow r'`；ro 实测 `rbd ls -p rbd-pool` 正常列出卷（原 Operation not permitted），`ceph df` 不受影响。
