# dsh-ops-plugins 领域词汇表

> 这个仓库的共同语言：写代码、讨论需求、分析 session 日志时用同一套词。
> 改代码若改变了某个词的含义，同步改这里。每个词都对应代码里真实存在的东西。

## 仓库与包

### 插件集合 (dsh-ops-plugins)

面向运维场景的 dsh 插件集合。单仓库 monorepo，`packages/` 下每个包有独立版本号、独立发布到 npm。开发期跨包依赖写 workspace 协议（`workspace:*` / `workspace:^x.y.z`），发布时由 pnpm 改写成真实版本号。注意：`dependencies` 里写裸 semver（如 `^0.1.0`）指向未发布的本仓库包，会让 pnpm 去 npm registry 找而 404——运行时依赖必须靠 workspace 协议；纯类型引用（`import type`）走 `peerDependencies` 裸 semver + `devDependencies` workspace 链接，peer 不会被拉取，是安全的。

### ops-tool-trace

**调查树** 工具插件（preset 平面，只对 ops 预设生效）。给 agent 一个 `trace` 工具，把事件排查组织成树形推理链，替代 todo 式的扁平清单。

### ops-trace-ui

**调查树面板** 插件（host 平面薄壳）。做两件事：注册共享的 `trace` 会话投影（定义唯一事实源在 ops-tool-trace 的 `traceProjection`），和携带 web 面板代码（`src/client.ts`）让浏览器发现。**不注册任何工具、不碰提示词**。必须在 host 平面——web 端靠扫描 host 组合条目发现面板代码，拿掉它面板就消失。这也是 trace 拆成两个包的原因：工具要按 preset 隔离，面板必须全局。

### ops-prompts

**提示词通道** 插件。提供两个注册口：

- **方法论段落 (methodology section)** — 静态文本，进系统提示词
- **提醒 (reminder)** — 一个检查函数，agent 每步执行前调用，条件成立就往 agent 的收件箱注入一条即时提示（持久、走 session 日志）

ops-tool-trace 通过它注册教义核心段和两条提醒规则；ops-prompts 自身不带业务内容。

## 凭证体系 (ops-access)

### 能力缝三角色

凭证体系按 dsh 的能力缝拆成三层，全部收在 `packages/ops-access/` 大文件夹里（分层一眼可见）：

- **定义包 ops-access/core**（npm 名 `@deepseek-ai/dsh-ops-access`，不变）— 拥有 `ctx.opsAccess` 服务和登记文件，定义词汇类型
- **提供方 ops-access/{k8s,ceph,ssh}** — 每种凭证类型一个，只有两样东西：该类型的 zod schema 和字段加工（如 `~` 展开）。通过 `register(kind, provider)` 注册进定义包
- **消费方 ops-tool-{kubectl,ceph,ssh}** — 模型工具，按名字解析凭证后拼命令。留在 `packages/` 顶层：它们是工具层，不是凭证层

### ops-shell-tool

**命令工具工厂**（`packages/ops-shell-tool`，纯库不是插件）。所有消费方共享的那套机器的唯一事实源：标准结果形状 `{ exitCode, stdout, stderr, command, error? }`、output schema、render、execute 模板（`ctx.get('opsAccess')` 现解析 → buildCommand 拼命令 → `ctx.shell` 执行，30s 超时，信号死亡 exitCode 归一为 -1，错误原样透传）。消费方只剩身份四件：工具名、解析的 kind、档案名参数名、`buildCommand`。

### 登记文件 (access.yaml)

凭证清单的唯一事实源（默认 `~/.dsh-ops/access.yaml`，Config 里只有 `registryFile` 一个路径字段）。按类型分段：`version: 1` 顶字段，段落名是 kind，条目 key 是档案名。**只显式登记，无自动发现**——发现逻辑是退役原型 k8s-plugin.js 里最脆的部分。

**每次解析现读现校验，不缓存**——改完文件立即生效，不用重启（对齐官方 credentials 缝的 per-operation 解析纪律）。

**管理文档走渐进披露**：`help()` 组合出登记文件的管理文档（文件路径、格式、envelope 字段、各 kind 的字段说明——来自提供方的 `fieldsDoc`），agent 通过 `list_access` 的 `help: true` 参数需要时拉取，系统提示词里不放。

### 访问档案 (AccessProfile)

`resolve(kind, name)` 的返回：`{ kind, name, description?, environment?, fields }`。`description`/`environment` 是所有类型通用的 envelope 字段；`fields` 是提供方 schema 校验+加工后的类型特有字段（k8s 是 `kubeconfigPath`，ceph 是 `confPath`/`keyringPath`，ssh 是 `host`/`user`/`keyPath?`/`port?`）。

**安全纪律是结构性的**：fields 里只有路径和连接参数，密钥内容永不过服务的手，因此日志、错误信息、模型上下文里天然不会出现秘密。`list_access` 工具的输出连 fields 都不带——只有名字和描述。

### 审计门 (Audit Gate) — 未来的独立插件

在 `tools/pre-execute`（waterfall 决策链）上挂监听器，读档案的 `environment` 标签做 allow/deny/ask 分级。不需要新事件：工具调用和审批结果本来就在 session 日志里；唯一可能新增的是一条 log-only 的"判定理由"事件。工具本身保持 dumb，策略不住工具里。

## 调查树 (Investigation Tree)

### 树 (Tree) 与 森林 (Forest)

一棵**树**对应一次调查：根是最终目标，下面挂假设和验证动作。一个会话可以有多棵树（**森林**），`create_tree` 开新调查时旧树作为历史保留。**活跃树** = 最后一棵未收口的树，所有操作默认作用于它。

### 节点 (Node)

树上的一个点。字段：`id` / `title` / `status` / `parent` / `turns` / `summary` / `detail` / `caused_by`。

**id 是手动起的语义 id**（如 `ceph-full`），不自动生成——自动 slug 会让 id 语义不明，这是定下来的规矩。

节点**不存类型字段**。三种角色由位置和用法区分：

- **目标 (goal)** — 根节点，id 固定为 `goal`，全案收口的终点
- **里程碑 (milestone)** — 深度 1。**可被证据判伪的假设**：创建时必须能写出 **假设句式** "我怀疑 X，因为看到了 Y"，Y 是已有证据。写不出 because 分句的不是假设，先取证
- **步骤 (step)** — 深度 2+，一个具体验证动作（查日志、跑命令）。执行前先 add_step，拿到结果立即 complete 带 summary

### 触发节点 (Trigger Node)

`parent_id` 的唯一规则。加节点前问：**"我为什么现在要做这个动作？"**

- 跟进某 step 的发现 → 挂那个 step（这就是**下钻**）
- 验证某假设 → 挂该 milestone
- 顶层假设 → 挂 `goal`

标题只写动作本身，推理关系全部由 parent 表达。

### 六种状态 (NodeStatus)

| 状态 | 含义 |
|---|---|
| `goal` | 需要达成的目标（根、里程碑）。比步骤稳定 |
| `pending` | 待开始的步骤 |
| `in_progress` | 进行中 |
| `done` | 完成 |
| `dead_end` | 证伪/走不通。**非终态**：可 reopen 重新探索，可继续挂子节点，保留在树上不删除，不级联影响子节点 |
| `resolved` | 最终目标已达成。终态 |

### 状态流转的语义分工

- **complete（带 summary）= 证实**：记录发现了什么
- **abandon = 证伪**：死路留在树上
- **start / reopen**：进入 / 回到进行中
- **resolve = 全案收口**：只作用于最终 goal，只调一次。假设的证实/证伪走 complete/abandon，**不用 resolve**

### detail 与 summary 的分工

- **detail** — 创建时的依据：假设的 because 分句，或 step 的具体查证对象
- **summary** — 完成时的结论：发现了什么、修了什么

### 因果边 (caused_by / link)

跨分支的因果关系（"X 的根因是 Y"）。父子关系已隐含触发链，不重复 link；link 只表达 parent 表达不了的边。

## 提示词体系

### 教义 (Doctrine)

trace 核心规矩的文案，**唯一事实源是 `src/doctrine.ts`**。工具描述、系统提示词核心段、help 全文、参数说明、提醒文案都从这里的常量组合——同一句话在所有地方措辞一致。

### 渐进披露 (Progressive Disclosure)

系统提示词只常驻 4 行核心（树是什么 + 触发节点规则 + 指针），完整用法由 agent 需要时调 `trace` action=help 自行拉取。提醒负责在恰当时机把单条规则递到眼前。

### 提醒规则与锁存器 (Reminder / ReminderLatch)

trace 有两条提醒规则，都是**纯函数**（输入提醒上下文，输出文案或 null）：

- **idle** — 活跃调查 5 步没更新 trace 时催促
- **nesting** — step 全部平铺在 milestone 下（深度判定：≥3 个深度 2 节点且无更深）且已有 step 带发现完成时，提醒下钻

**锁存器** 保证不刷屏：单调版本号（历史重放不会重新武装规则）+ 最小间隔 + 每会话触发上限。无限循环事故的教训就固化在这里。

### 提醒上下文 (ReminderContext)

每次 pre-step 派生一次：步数只扫事件头（不 parse 参数），树直接从 SessionForestStore 拿，不重放历史。

## 状态与投影

### 投影 (Projection)

session 事件日志是唯一真账本，树状态由事件 fold 而来。模型可见的任何东西都必须能从日志重建。

### SessionForestStore

每个会话的树状态的唯一所有者（`src/session-forests.ts`）。首次访问从投影播种（失败会告警）；`apply` 是纯同步临界区——验证、fold、存回一气呵成，这是原子性的保证；幻影树防护（框架已 fold 过的事件不重复 fold）也在里面。

### 树布局 (tree-layout)

`src/tree-layout.ts`：排序（进行中优先、goal 最后）、索引、深度、DFS 展开的纯函数。**宿主渲染器和 web 面板共用同一份**——人看到的树和模型看到的树是同一个布局。面板在另一个包（ops-trace-ui），通过 `@deepseek-ai/dsh-ops-tool-trace/tree-layout` 子路径导出共享。

## Web 面板词汇

### 面板 (Trace Dock)

输入区上方的 trace 面板。**折叠状态和选中的树按会话记住**，切换会话再回来不丢。

### 树选择器 (Selector)

多棵树时头部的 `Trace N/M` 切换器。未手动选择时默认跟随**活跃树**，不是第一棵。

### 字形 (Glyph)

节点左侧的状态图标，状态的视觉载体。

### 节点行

按 DFS 顺序渲染的缩进列表：同级按状态排序，深度决定缩进。有 summary 或 caused_by 的节点可点击展开详情。dead_end 节点标题半透明加删除线。

## 开发与验证工作流

1. 在 `dsh-ops-plugins/packages/<包>` 改代码
2. 包内 `npm run build`（插件加载的是构建产物 `lib/`，不构建不生效）
3. `npx vitest run` 跑该包测试
4. `systemctl restart dsh-ops` 重启测试实例
5. web（127.0.0.1:3082）跑真实排查 session 验证行为

测试实例在 `../.dsh-target`（profile `dev-target`），所有插件以 `link:` 方式接入。真实 session 的行为验证（提醒触发、树渲染、凭证解析）只能在这里做，单测替代不了。
