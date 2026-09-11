# @elinpf/dsh-ops-tool-trace

运维模式的调查树工具：用扩散-收敛的树（假设、步骤、死胡同、收口）替代 todo 式扁平清单——一棵能在上下文压缩后依然存续的外部记忆。

## 功能

agent 通过 `trace` 模型工具维护调查树。每次调用向会话日志追加一条增量事件；`trace` 会话投影（由 `@elinpf/dsh-ops-trace-ui` 在 host 平面注册，定义由本包共享出去，两包永不漂移）把事件 fold 成当前森林状态，供 web 面板渲染。一个会话持有的是**森林**：已收口的树保留备查，活动树是最近一棵未收口的。

- **11 个动作**:`create_tree`、`add_step`、`add_milestone`、`start`、`complete`、`abandon`、`reopen`、`resolve`、`link`、`view`、`help`
- **6 种状态**:`goal`、`pending`、`in_progress`、`done`、`dead_end`、`resolved`
- **milestone 是可证伪的假设**——只能写成「我怀疑 X, 因为看到了 Y」；对 milestone 做 `abandon` 就是证伪操作
- **死胡同不删除**——它是防止重复排查的记录；`reopen` 可复活被误关的节点
- **`link`** 只记因果边(`caused_by`）不改状态——证实要走 `complete` 带 summary，不是 link
- **`resolve(goal)` 有硬门槛**：所有非根节点必须先定论（`done`/`dead_end`)。`force: true` 是中途放弃调查的逃生口——结果的 WARN 会点名每个被搁置的节点，并声明这次收口是未实证断言
- **`view`** 渲染完整树（默认）或缩进轮廓（`format: tree`);**`help`** 渐进披露完整教义

## 唯一的结构规则

`parent_id` 只回答一个问题——我为什么现在要做这个动作：跟进某 step 的发现 → 挂那个 step；验证某假设 → 挂该 milestone；顶层假设 → 挂 `goal`。`add_step` 的平挂提示和 `trace:nesting` 提醒都在守这个形状。

## 提醒（经 ops-prompts 注册）

三条即时提醒规则在 agent 每步执行前检查树的卫生状况；每条都是 `ReminderContext`（事件日志里的 step 位置 + 活树状态）的纯函数，挂在 `ReminderLatch`（最小间隔 + 倍增退避，按会话）后面：

- **`trace:idle`** — 排查中 5+ 步没更新 trace（每次触发后间隔翻倍，40 步封顶；agent 遵从后重置回 5)
- **`trace:nesting`** — step 全平挂在 milestone 下而已有 step 带发现完成（该往下钻了）
- **`trace:stale-step`** — 开放的 step(pending/in_progress）超过 4 轮没有定论：要么 complete 带 summary，要么 abandon（死路也是成果），要么在 detail 里写明在等什么

## 设计要点

- **只在 preset 平面**。本包携带工具、教义（系统提示词段 + 经 ops-prompts 的提醒）和投影**定义**；投影注册和面板都在 `@elinpf/dsh-ops-trace-ui`(host 平面——web 靠扫描 host 条目发现面板）。面板在没有 trace 投影数据时隐藏自己——这是设计行为，不是 bug。
- **事件即真相**。状态是会话事件日志的左折叠（`foldEvent`,`stateVersion: 5`)；内存 store 在 HMR 后从投影重建，compaction 无损——树就是 agent 抗压缩的工作记忆。
- **报错即教学**。被拒的调用都说下一步该怎么做（resolve 门槛列出未定论节点；abandon 根 goal 会指路 resolve；非法状态转移同时报出两个状态）。

## 配置

| 键 | 默认 | 作用 |
|---|---|---|
| `idleReminderGapSteps` | `5` | 多少步没更新 trace 触发 idle 提醒 |
| `idleReminderBackoffCeilingSteps` | `40` | idle 提醒倍增退避的上限 |
| `nestingReminderFlatSteps` | `3` | 平挂多少个 step 触发 nesting 提醒 |
| `staleStepReminderTurns` | `4` | 开放 step 多少轮无定论触发 stale-step 提醒 |

## 安装

随 `@elinpf/dsh-ops` 套件 preset 提供（`ops-orchestration` 组，与 ops-prompts 共享 isolate realm)。单独引用时加进 preset 的 `agent.cordis.yml`——注意没有 host 平面的 `@elinpf/dsh-ops-trace-ui`，工具在 UI 里不可见：

```yaml
- id: tool-ops-trace
  name: '@elinpf/dsh-ops-tool-trace'
```

## 测试

`vitest run`——工具动作与状态转移、投影 fold（含被拒的 resolve 永不收口树）、session 森林 store、提醒规则（手工构造上下文的纯函数测试）、教义文本不变量、HMR 卸载（工具/方法论/全部提醒随 fiber 消失）。

## 已知限制

- 子 agent 不能直接写树——主 agent 代为转记
- lane/depth 布局由 client 派生，不存储
- 无回放/时间轴 UI（事件都在会话日志里）
