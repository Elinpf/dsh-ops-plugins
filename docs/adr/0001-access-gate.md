# ADR-0001: 审计门设计 —— 凭证代发、两档账号、按会话授权

- 状态：已接受（已实现 — 门接进 ops preset，ro/rw 代发、按会话授权、TTL 回落、ssh 审批、JSONL 审计均已在 `.dsh-target` 真实环境验证）
- 日期：2026-08-25
- 背景会话：/grilling 烤问，覆盖权限落实层、命令分类、审批疲劳、共享账号并发、凭证存放

## 上下文

ops-access 目前把凭证档案平权地发给所有工具调用，agent 拿着什么权限取决于档案里登记了什么——等于默认全权限。要加审计门，先回答四个问题：权限在哪一层落实、"只读"由谁判定、提权的粒度、并发会话如何隔离。

## 决策

### 1. 威胁模型定为"防犯傻"，不为"防主动作恶"建设

同进程同 UID 下，agent 若有通用 bash/任意文件读，进程内无秘密（`/proc/<pid>/environ`、凭证文件路径都可得）。防作恶的唯一出路是工具面收敛（禁通用 shell）或门独立成进程——建设成本高一个数量级，且损害排查自由度。选择不做，靠"ro 是基础设施强制"兜底。

### 2. 门做凭证代发，不做基础设施权限变更

否决了"门调用 k8s API / ceph auth 动态改 AI 账号权限"的方案。该方案要处理生效延迟、回落基线漂移，且门需持有各系统 admin 凭证（皇冠明珠问题）。改为：基础设施上静态预置 ro/rw 两套账号，门只按会话决定发哪套。共享账号并发污染、撤销竞态、回落漂移三个问题随这一翻转全部消解。

### 3. 两档粗粒度，不做动词级细粒度

`registerProfiledShellTool` 保留自由命令字符串（不重写工具层）。自由字符串与细粒度权限根本矛盾：门无法可靠解析命令语义（`kubectl exec`/`port-forward`/`ssh` 任意命令），字符串分类器误判即漏洞。粒度收敛为 profile × {ro, rw}。审批语义因此干净："允许对 prod 集群写操作 30 分钟"。

### 4. 审批一次性，不逐命令

逐命令审批 → 人疲劳 → 无脑点允许，比没有门更糟。采用"agent 先出方案、人统一批准、授权带 TTL"的变更单模式。TTL 是唯一可靠的回落边界（web session 无可靠结束事件）。

### 5. 账本按 `exec.agent.id` 分键，undefined 时 fail-closed

dsh 源码验证（tag dsh-v0.1.0-rc.8）：`tools/pre-execute` payload 的 `exec.agent.id === session.id`（`packages/core/agent/src/index.ts:475` 注册表强制）；preset 平面插件是全进程共享实例（`packages/preset/agent-presets` standing mount），闭包不能当账本；`exec.agent` 可选，插件自发调用时缺失，必须 fail-closed。审批交互用 dsh 原生通道，不自造。

申请入口采用**显式 `request_access` 工具**（agent 陈述方案、人一次批准、入账），代发点在 resolve（按 agent 上下文换发 rw）。初稿曾设想"pre-execute 逐调用 ask"——那本质仍是逐命令打断，与决策 4 的变更单模式相悖，spec 定稿时修正。

### 6. rw 凭证不进 access.yaml；双文件归 core，门只做决策

`access.yaml` 对 agent 明文可见（`list_access help` 甚至教它编辑此文件），rw 必须另存。但 rw 文件的读取/校验**不由门管**——core 增加 `rwRegistryFile` 配置，用同一套机器管两个文件；门注册的 broker 是纯决策函数 `(kind, name, agent) => 'ro' | 'rw' | 拒绝`，从头到尾看不见凭证字段。策略与秘密材料彻底分离，延续"秘密不过服务的手"。被否决的替代：门自管 rw 文件（策略层碰凭证、读取纪律复刻一份）；加密 sqlite + 临时文件——加密防磁盘不防 agent（密码在进程内），临时文件反而制造守株待兔原语（盯临时目录等 rw 出现）且崩溃残留。

### 7. ssh 不分档，每次审批

Linux 无真只读 shell（能登录就能写 /tmp、跑程序），两档是伪命题。ssh 主场景是临时进入操作、频率低，每次审批不构成疲劳。成熟形态：门持 ssh CA 私钥签短证书（自带 TTL，免撤销），依赖目标机部署 `TrustedUserCAKeys`，二期再做。

### 8. 二期中心服务只上收 rw，走 provider 缝

团队每人各跑一个 dsh，rw 人手一份拷贝不可接受。中心服务作为 ops-access 的 remote 后端（provider 缝后面换实现），账本与工具链不变。ro 留本地保可用性。必备 break-glass 本地应急钥匙（动用即告警）——中心服务故障往往正是救火时。身份来自服务侧每人一把个人钥匙。

## 被否决方案汇总

| 方案 | 否决原因 |
|---|---|
| 模型层拦截为唯一防线 | 绕过面太大（bash、fs 改 access.yaml），只能当提示不能当门 |
| 命令字符串分类只读/写 | 误判即漏洞；ssh/exec 类无法分类 |
| 结构化 verb 工具重写 | 收益不值得推翻工具层；粗粒度两档已够 |
| 逐命令审批 | 审批疲劳 = 没有审计 |
| 门动态改基础设施权限 | admin 凭证集中、生效延迟、回落漂移 |
| 加密 sqlite + 临时凭证文件 | 加密不防同 UID agent；临时文件是可偷的静态秘密拷贝 |
| 每会话动态建账号 | 多数基础设施不适合高频建删，实现重 |
| 门代执行（堡垒机） | 推翻通用命令工具直连架构，防犯傻用不上 |

## 后果

- 一期实现范围：core 管双文件 + broker 挂点；门包含按 agent 分键的账本、`request_access` 工具（原生审批通道）、纯决策 broker、审计日志。provider 层零改动，工具层仅工厂一处（透传 `exec.agent`）。
- 架构上为二期留的口：provider 缝后不泄露凭证来源；"批准人"字段预留。
- 已知接受的风险：agent 被强注入后可用 ro 做信息探测、可诱导人批准（审批说明由 agent 自述）。威胁模型 A 下接受。

## 实现期修正（2026-08-25 架构走查后落地，不推翻以上决策）

- **无 agent 的裁决权上收给 broker**：初实现是 core 短路（无 agent 不咨询 broker 直接发 ro）——这让 ssh 的 deny 对无 agent 调用不可达，且 core 替门做了政策决定。改为 broker 签名收 `agent | undefined`、core 注册了 broker 就每次必咨询；门的裁决：两档 kind 回落 ro，approvalRequiredKinds 拒绝（ssh 凭证本质是 rw，无会话可键权就不发）。决策 5 的 fail-closed 语义因此完整。
- **可交付性预检与代发同深**：core 的 `canResolve(kind, name, tier)`（存在 + provider schema 校验，不返回 fields、不咨询 broker）替换了只看 key 存在的 `hasRwEntry`——条目存在但非法时，审批前就打回，不再批准后炸。
- **账本重置可审计**：apply（启动与 HMR 重载）落一行 `ledger-reset` 审计。HMR 清空与重启清空同语义，此前未声明。
- **@ 档案引用走元数据路径**：mention 渲染改用 `list()` 而非 `resolve()`——渲染信封不需要授权，否则 ssh 档案被 @ 时会因无授权误报"未找到"。
