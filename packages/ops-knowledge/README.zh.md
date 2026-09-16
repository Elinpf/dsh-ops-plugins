# @elinpf/dsh-ops-knowledge

DeepSeek Harness 运维模式的排错知识库 —— 把排查收口后的结晶沉淀为**病例**（`症状 → 根因 → 修复`），集中存放在 [ops-access-hub](../ops-access-hub/)（`/cases` 路由），让后续会话直接复用历史结论，避免重复排查。

## 工作方式

三个模型工具，外加经 `ops-prompts` 的 prompt 接线：

- **`knowledge_search`** —— 按关键字搜病例索引（title ×3 / tags ×2 / symptoms ×2，子串、忽略大小写），返回相关度最高的病例全文。纪律要求 agent 动手排查前先搜。
- **`knowledge_record`** —— 把一次收口的排查提炼成病例；带 `id` 则更新旧病例（纪律：先查重，有近似旧病例就更新，没有才新建）。病例除结论（症状/根因/修复）外还可带 `methodology`（方法论：当时怎么查出来的，关键判别步骤——供"症状不同但问题同类"的场景复用）和 `difficulty`（1-5 难度自评）；难度 ≥3 的病例必须写方法论。
- **`knowledge_hit`** —— 标记某病例被本次排查采用；`hitCount` 决定会话启动索引的排序，有用的病例浮上来，没用的沉底。

两个 prompt 面（经 `ops-prompts` 注册，与 ops-tool-trace 同款 `ctx.get`/`ctx.inject` 双模式解析）：

- 静态 methodology 一节（先搜后沉淀、采用计数的纪律 + 病例质量要求）；
- 每会话一次的启动 reminder：在第一个 pre-step 注入病例索引（title + 症状，按采用数取 top 10）。reminder 的 `check` 是同步签名，索引在插件启动时预取进内存、每次写操作后刷新。

## 配置

| 键 | 缺省 | 用途 |
|---|---|---|
| `hubUrl` | 环境变量 `ACCESS_HUB_URL` | hub 地址，如 `http://127.0.0.1:3090` |
| `hubToken` | 环境变量 `ACCESS_HUB_READ_TOKEN` | hub token——**read** 令牌即可（hub 刻意放行 read 角色写 `/cases`；病例不含机密） |

配置和环境变量都没有时，插件记一行日志后整体 no-op（不挂工具不挂 prompt）。运行期 hub 不可达时，工具返回错误**结果**（绝不抛出）、reminder 静默——知识库故障绝不拖垮会话。

## 接线

preset plane：`ops-orchestration` isolate realm 组内加一行（它消费 `opsPrompts`）：

```yaml
- id: tool-ops-knowledge
  name: '@elinpf/dsh-ops-knowledge'
  # 可选；环境变量回退已够用
  config:
    hubUrl: http://127.0.0.1:3090
    hubToken: <read-token>
```

随套件发布的 `ops` preset（`packages/ops/presets/ops/agent.cordis.yml`）已带这一行且无 config，由进程环境变量驱动。

## 测试

```sh
npm run build     # tsc → lib/
npx vitest run    # 打分单测、export shape、HMR 卸载、无 hub no-op、
                  # 对 in-process hub server 的全链路工具测试
```
