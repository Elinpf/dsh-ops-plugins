---
"@elinpf/dsh-ops-knowledge": minor
"@elinpf/dsh-ops-tool-trace": patch
"@elinpf/dsh-ops": patch
---

新包 `@elinpf/dsh-ops-knowledge` — 排错知识库插件: `knowledge_search` / `knowledge_record` / `knowledge_hit` 三个模型工具(access hub `/cases` 后端), 经 ops-prompts 注册静态 methodology(先搜后沉淀、采用计数纪律) + 每会话一次的病例索引 reminder(按 hitCount 取 top 10)。病例除结论(症状/根因/修复)外还有可选 methodology(排查方法论: 关键判别步骤) 和 difficulty(1-5 难度自评) 字段; `knowledge_search` 支持 query="*" 浏览全量。无 hub 配置时整体 no-op; hub 不可达时工具返回错误结果而非抛出。trace 的 doctrine HELP_TEXT 新增「收口后的知识沉淀」段, ops 部署包的 preset 带上 `tool-ops-knowledge` 行(无 config, 走 `ACCESS_HUB_URL`/`ACCESS_HUB_READ_TOKEN` 环境变量)。
