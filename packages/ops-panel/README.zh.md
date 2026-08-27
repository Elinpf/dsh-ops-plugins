# @deepseek-ai/dsh-ops-panel

DeepSeek Harness 运维插件的面板缝 — 会话作用域对话框的公共机制，由斜杠命令触发（ADR-0004）。

## 它做什么

业务包不应各自重造对话框外壳、键盘处理和命令分发。ops-panel 把这件事拆成两半：

- **client 半**（`ops-panel-client`）：提供 `opsPanels` 注册表服务。消费方每个命令注册一条面板定义 — `registerPanel({ command, title, component })`。外壳把打开的面板渲染为遮罩上的居中卡片（Escape / 点遮罩关闭），注入 `conversation.input.overlay` 槽位。单一的 `command/executed` 监听器按命令名分发 — N 个面板只花一个监听器。
- **host 助手**（`registerPanelCommand(ctx, { name, description })`）：注册斜杠命令本身 — 一个空操作的成功 handler，唯一职责是存在于会话命令目录里，让 UI 允许提交并触发 `command/executed`。从 preset 面调用时按 agent 作用域注册；`commands` 服务缺席时直接报错。

面板组件收到 `{ sessionId, close }`，卡片内的一切（取数、轮询、动作）归它自己管。

## 为什么是服务而不是库

按消费方各自打包会得到 N 份注册表、N 个 `command/executed` 监听器、N 个遮罩外壳 — 而只有最后注册的外壳生效。作为 cordis 服务，每个页面只有一份注册表和一个外壳，任何插件都能注册面板。

## 安装

加入 app 依赖并在 `cordis.patch.yml` 引用（host 面）：

```yaml
- id: ops-panel
  name: '@deepseek-ai/dsh-ops-panel'
```

## 已知限制

- 同时只打开一个面板（打开另一个会替换当前的）。
- 外壳刻意极简（标题 + 关闭）——标签页、尺寸、拖拽留给有第二个消费者时再迭代。
- `command/executed` 只在挂了这个命令的会话里触发 — 面板天然是 preset 作用域的。
