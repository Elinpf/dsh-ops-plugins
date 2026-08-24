# @deepseek-ai/dsh-ops-todo-tree

运维模式调查树工具 — 用扩散-收敛树替代 `todo_write`，记录步骤、里程碑、死胡同和已解决终端。

## 功能

Agent 驱动的调查跟踪：agent 通过 `todo_tree` 模型工具维护调查步骤树。每次调用向会话日志追加增量事件；session projection 将事件 fold 成当前树状态；client 渲染 git-graph 风格的扁平列表，带彩色轨道线、可展开行和状态图标。

- **8 个动作**：`create_tree`、`add_step`、`add_milestone`、`start`、`complete`、`abandon`、`resolve`、`note`
- **6 种状态**：`goal`、`pending`、`in_progress`、`done`、`dead_end`、`resolved`
- **死胡同不删除** — 保留在树上作为探索记录
- **分支**：`branch=true` 在并行轨道探索侧路径
- 每次调用返回完整树 + 状态摘要（顾问，非守门员）

## 安装

添加到 `dsh-web-app` 依赖，并在 ops preset 的 `agent.cordis.yml` 中引用：

```yaml
- id: tool-ops-todo-tree
  name: '@deepseek-ai/dsh-ops-todo-tree'
```

## 模型体验

### todo_tree 工具

#### 模型看到什么

工具描述（8 个动作及使用时机）+ 系统提示词 section（使用指南）。

#### Token 影响

工具 schema + 描述（约 200 token）+ 系统提示词 section（约 300 token）。

#### KV Cache 影响

跨轮次稳定 — 工具描述和提示词 section 是静态的。

## 已知限制和待办事项

- 无跨会话连续性（v1：一个会话一棵树）
- 无人工编辑（纯 agent 驱动）
- lane/depth 在 client 侧计算（布局是派生的，不存储）
- 子 agent 不能直接写树 — 主 agent 需代为操作
- 无回放/时间轴 UI（事件在会话日志中，但无专门时间线视图）
