# @elinpf/dsh-ops-prompts

DeepSeek Harness 的 ops 提示词编排中心 — 其他 ops 插件通过这一个渠道注册方法论 section(静态系统提示词文本)和动态 reminder(pre-step 检查函数,注入临时提示词)。

## 功能

- **`ctx.get('opsPrompts')` 句柄**,两个注册面,都返回 disposer:
  - `registerMethodology({ name, order, text })` — 静态系统提示词 section。所有条目由同一个 `ops:methodology` section 渲染(按 `order` 排序),每次组装提示词时重新求值,所以晚注册和注销都能即时生效。
  - `registerReminder({ name, check })` — 每个 `agent/pre-step` 求值的规则。非空结果拼接后通过 `agent.inject` 投递,走持久化 inbox splice:reminder 可以从会话日志重建(model-visible ⟺ logged)。
- **核心 ops 方法论**(`ops:core`,order 250):根因纪律、下结论前先验证、调查结构化 — 所有 ops 工具共享的基线。
- **bundled skills provider**(`ops-prompts-bundled`,`src/skills.ts`):把本包 `skills/` 目录送进 dsh 原生 skill 子系统。带原生 frontmatter 的 Markdown(`name`/`description` 必填,`whenToUse` 可选,支持 `disable-model-invocation`)成为 catalog 候选;正文通过 `skill` 工具按需拉取。skills 注册表是可选依赖 — 先 `ctx.get` 再 `ctx.inject` 兜底,缺失时容忍(包退化为纯提示词渠道)。

## 设计要点

- **一个 section,多个条目。** 方法论文本聚合进单个系统提示词 section,而不是每个贡献者一个 section:排序靠 `order` 显式表达,提示词组装只读一个闭包。
- **reminder 是临时的,永远不是持久状态。** 规则活在 fiber 局部 Map 里;只有注入的消息经由平台自己的 inbox splice 进入会话日志 — 因此本包不拥有任何 session 事件类型,也不需要 projection。
- **一切注册都是 fiber 作用域。** 系统提示词 section 和 skills provider 走 `ctx.effect`,pre-step 监听器经 `ctx.on` 挂在 fiber 上。fiber 销毁/HMR 会卸掉所有注册面(`tests/hmr-unload.spec.ts` 覆盖)。
- **纯提示词 skill 就是一个文本文件,永远不是一个包** — bundled provider 的意义在于让仓库维护的 Markdown skill 搭原生 catalog 的车,而不是自建加载器。

## 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `reminderEnabled` | `boolean` | `true` | 是否在每个 agent/pre-step 求值动态 reminder。 |

必需 inject:`systemPrompt`。可选:`skills`(host 平面注册表)。

## 测试

```sh
npm run build   # tsc → lib/
npx vitest run  # 单元测试 + HMR 卸载测试
```

`tests/ops-prompts.spec.ts` 覆盖句柄、方法论聚合和 reminder 投递;`tests/skills.spec.ts` 覆盖 frontmatter 解析、bundled provider 和可选 skills 注册;`tests/hmr-unload.spec.ts` 执行所有收集到的 disposer 并断言每个注册面都被移除。
