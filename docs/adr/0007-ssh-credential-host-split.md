# ADR-0007: SSH 凭证与主机分离（ssh-cred kind + core 引用机制）

- 日期：2026-09-08
- 状态：已决定（已与 feat/access-hub 合并，双线实测通过）

## 背景

原 ssh 条目是单体：`{ host, user, key?, port? }`——每注册一台主机都要粘贴一遍私钥，同一把密钥在注册表里有 N 份拷贝：轮换要改 N 处，粘贴错误面也乘 N。另一面，网络设备等只提供密码登录的 ssh 端根本无法登记（工具侧 `BatchMode=yes` 从机制上排除了密码）。两类场景的共性是**凭证与主机本应分离**：凭证（密钥/密码 + 默认登录用户）是少数几份共享资源，主机只是「连哪 + 引用哪份凭证」。

## 决定

1. **新增 `ssh-cred` kind**（与 `ssh` 同包注册）：`{ user?, key?, password? }`，key/password 至少一个。凭证登记一次，主机条目以 `cred: <名字>` 引用；轮换只改凭证一处。
2. **core 增加通用引用机制**而非 ssh 特例：provider 声明 `references: { cred: 'ssh-cred' }`,resolve 时把被引用条目（同注册表、同 tier）的字段合并到引用方**之下**——引用方字段赢冲突（per-host 覆盖 user 即由此而来）。只展开一层。配套 `validateResolved` 钩子做合并后校验（登录 user 可来自任一侧，条目 schema 无法单独要求）。
3. **被引用凭证不单独过 broker**：它是引用方 resolve 的实现细节。一次使用 = 一次对主机条目的授权，审批语义不变（用户拍板，2026-09-08）。
4. **密码登录走 `sshpass -f <密码文件>`**：密码作为 fileField 物化为 0600 文件（与密钥同一套受管文件机制），工具侧对密码型档案关闭 BatchMode 并固定 `PreferredAuthentications=password` + `PubkeyAuthentication=no` + `NumberOfPasswordPrompts=1`（错密码快速失败，本地散密钥不抢道）。接受 sshpass 这个系统依赖（用户拍板，2026-09-08）；保存时校验密码必须单行（`sshpass -f` 只读首行，内部换行会在使用时静默截断）。
5. **向后兼容**：主机条目内联 `key`/`password` 继续可用（遗留/一次性场景）；`user` 从必填降为可选（可来自凭证），由 `validateResolved` 兜底合并后必填。

## 备选方案（已否）

- **工具侧二次 resolve**（ssh 工具自己解析 ssh 再解析 ssh-cred）：access 缝不变，但每个消费方都要懂引用结构，且被引用凭证会单独过一次 broker——审批语义变复杂，否。
- **provider 的 process 改为 async 并注入解析器**：把引用展开留在 provider 层。但 process 是同步纯函数，且 k8s/ceph 未来也可能要共用（多 context 共享 CA)，放 core 做成声明式更干净。

## 后果

- core 的 `AccessProvider` 增两个可选钩子（`references` / `validateResolved`);resolve/canResolve/list 三条路径共用 finalizeProfile 展开，行为一致（悬挂引用 = 不可解析）。
- **access-hub 集成（已落地）**：当初担心的顺序问题（引用展开必须先于 fileField 物化）由结构自然解决——finalizeProfile 不走注册表直读，而是对被引用条目调同一个 `backend.loadTier(refKind, refName, tier, { materialize })`；hub 模式下被引用凭证的内容在展开点上完成抓取+物化，`materialize` 标志随调用方意图传递（resolve 物化、canResolve/list 只给路径不写盘）。
- UI 零改动：access-ui 的 kind 列表来自 `listKinds()`,ssh-cred 自动出现。
- 实测：yaml 模式（.dsh-explore,2026-09-08）与 hub 模式（.dsh-target + 本地 hub,同日）各跑通三条路——密钥（一份 ssh-cred 两台主机真实连通 10.10.136.100)、密码（本机专用 sshd + 测试用户,sshpass 登录成功)、悬挂引用（resolve 报错指路 + admin list 标 not-ok,hub 模式报错带 `access hub at` 来源标签)。测试条目/临时用户/sshd 均已清理。
