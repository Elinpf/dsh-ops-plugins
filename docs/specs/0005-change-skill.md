# 0005 — 修复变更 skill（四阶段多 agent 隔离）

## 问题陈述

排查出问题之后的修复阶段，出方案、验证方案、审核、执行是四种不同的认知活动。混在同一个上下文里会互相污染：验证者被诊断者的确信感传染（确认偏误），执行者被排查过程中已证伪的错误路径带偏。需要机制把这些阶段隔离开，各用各的干净上下文。

## 解决方案

一个 **ops 专属 skill**（纯提示词，无新工具）：在 ops-prompts 通道注册"修复变更"方法论，教主 agent 用 preset 里已有的 `subagent`(spawn）工具按四阶段纪律工作。skill 按标准结构组织：触发条件常驻系统提示词，完整 workflow 按需拉取。

**载体**：纯文本 skill 走 **dsh 原生 skill 子系统**——skill 文件是 Markdown + 原生 frontmatter（`name`/`description` 必填，`whenToUse` 可选），ops-prompts 以 **bundled skill provider**（`ops-prompts-bundled`，扫包内 `skills/` 目录）把仓库版 skill 注册进原生注册中心：catalog 常驻 name+description（模型经 `skill` 工具按需拉取正文），用户/团队 skill 走 `skill-filesystem` 的原生目录分级。（两轮被否的形态：独立插件包——纯 prose 无工具耦合，打包是重壳；ops-prompts 自建目录加载器——重复造 dsh 已有的轮子。)

## 阶段模型

1. **出方案**——主 agent，带完整诊断上下文（trace 调查树是现成的压缩产物）。方案要素：目标、步骤、预期结果、回滚、影响面
2. **验证**——spawn 新 agent，干净上下文只给方案文本；静态推演 + ro 权限查证环境现状；产出验证报告（通过 / 打回+理由）
3. **回环**——打回则验证报告挂回 trace 树，主 agent 修订再送验；**3 次上限**，超限升级给人
4. **审核**——人，走现有授权面板（零改动）
5. **执行**——spawn 新 agent，干净上下文只给已批准的步骤；rw 授权走 **B 方案**：执行 agent 自己经授权面板申请（探索期零改动）

## 实现决策

- **触发**：修复是重操作，**只能由人显式启动**——frontmatter 带 `disable-model-invocation: true`，skill 不进模型 catalog、`skill` 工具也拉不到；唯一入口是用户消息首行 `/change`（dsh 原生用户触发通道）。典型时机：trace 调查树收口、确认修复需要 rw 之后
- **机制事实**（已调研，dsh 源码证据）：spawn = 干净上下文（继承 preset 方法论段落——正好，trace 教义不丢）；子 agent 结果可回传、可持续对话（修订送验在原子会话追问，不重派生）；rw 授权**不**随派生传递（子 session id 是新随机 UUID，授权账本按 session id 分键）——这是 B/A 之争的根源
- **rw 授权**：探索期 B（子 agent 自己申请，面板显示随机 UUID 归因难看但可用）；验证价值后做 **A**（审计门血缘传递：子 meta 里有 `parentSession` 可循，人批一次、约束只沿 spawn 血缘传一层、rw 代发照落审计）
- **纪律守不住的部分再固化成插件代码**——skill 先行，代码兜底
- **挂载**:preset 的 `ops-orchestration` 组（opsPrompts realm)，参考 `tool-ops-environment-prompt` 行

## 测试决策

- 纯提示词包：测导出形状（name/inject/apply、注册段落的行为）、文案一致性（doctrine 单一事实源）
- 真实验证在 .dsh-explore(3083)：跑一个需要 rw 修复的场景，观察四阶段纪律是否被遵守、验证 agent 上下文是否干净、回环是否收敛

## 范围之外

- 新工具/状态机插件（纪律守不住才做）
- rw 授权血缘传递（A 方案，后续）
- 环境内预演验证（验证深度只到静态推演 + ro 查证，预演后置）

## 备注

- ops-prompts 是 skill 分发器：系统提示词常驻触发条件，正文按需拉取。trace/list_access/environment 方法论与本期 change 同属 ops 专属 skill 库
