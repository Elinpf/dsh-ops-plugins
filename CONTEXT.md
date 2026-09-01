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

### ops-panel

**面板缝**（ADR-0004 / spec 0003，已落地：packages/ops-panel）。会话作用域对话框的公共机制，独立插件包、以 cordis 服务形态提供（client 半 `ctx.opsPanels`，key 复数 = registry）：`registerPanel({ command, title, available?, component })` 注册一个面板，框架持有单一 `command/executed` 监听按命令名分发 + overlay 外壳（标题栏/Escape/背景关闭/每会话开关状态）。node 半只有无状态 helper `registerPanelCommand`（注册空 handler 的 host 命令，让 `/名字` 进斜杠菜单）。**服务而非纯库**——纯库会被各消费方 bundle 各打包一份，注册表/监听/外壳互撞（双模块实例教训）。先例是 dsh 的 ui-commands（`ctx.commandUi`），本缝是它的"完整对话框"档。消费方只剩四件身份：命令名、面板标题、内容组件、可用性过滤器。命令触发之外另有命令式 `open(sessionId, command)`/`close(sessionId)`（ADR-0004 §9），供待办信号拉起面板——第一个消费方是授权面板的待决申请角标（输入区 dock 红点计数，从会话快照 runningCalls 派生在飞的 request_access 数，零轮询；点击开审批台）。**第二消费方（票 13）是授权总览 `/access-all`**：跨会话查看所有在飞 rw 授权/待决申请/封禁列表（数据源 gate 新只读路由 `GET /ops-access/grants/all` + `OpsAccessGate.listAll()`），按授权收回、按会话收回全部、多会话时一键全局收回（复用既有 per-session 路由，未新增写路径）；注册 API 原样够用，ADR-0004 决策 8 的反向检查点通过。

### ops-prompts

**提示词通道** 插件。提供两个注册口：

- **方法论段落 (methodology section)** — 静态文本，进系统提示词
- **提醒 (reminder)** — 一个检查函数，agent 每步执行前调用，条件成立就往 agent 的收件箱注入一条即时提示（持久、走 session 日志）

ops-tool-trace 通过它注册教义核心段和两条提醒规则；ops-prompts 自身不带业务内容。

## 凭证体系 (ops-access)

### 能力缝三角色

凭证体系按 dsh 的能力缝拆成三层，全部收在 `packages/ops-access/` 大文件夹里（分层一眼可见）：

- **定义包 ops-access/core**（npm 名 `@deepseek-ai/dsh-ops-access`，不变）— 拥有 `ctx.opsAccess` 服务和登记文件，定义词汇类型
- **提供方 ops-access/{k8s,ceph,ssh}** — 每种凭证类型一个：该类型的 zod schema、字段加工（如 `~` 展开）、可选的 `validateContent` 保存时内容校验。apply 里只调定义包的 `registerAccessProvider(ctx, provider)` 帮手注册——不要手写 `ctx.inject(['opsAccess'], ...)`（静态 inject 兄弟行服务会让 loader 死锁，帮手内含这段防护）
- **保存时内容校验 (validateContent)** — provider 可选钩子，文件类字段的粘贴内容**落盘前**做结构性校验（k8s：合法 YAML 且有 clusters/contexts/users，且 `current-context` 必须指向已定义的 context——ops 工具不带 `--context`，缺失或失效的 current-context 会让每次调用都炸；ceph：[global]/mon_host + keyring 的 key 行缩进且 base64 ≥16 字节；ssh：**盔甲检查 + 真实解析**——`ssh-keygen -y -P ''` 跑通才放行（与 ssh 连接时同一个解析器），加密私钥报 BatchMode 不可用的明确错误）。钩子可以是**异步**的（ssh 要跑子进程）；provider 可声明 **`normalizeTrailingNewline`**（ssh/ceph 启用）在**校验前**把内容归一化为恰好一个结尾换行——PEM 的 END 行必须换行终止，粘贴/模型转述常丢这一字节（2026-08-27：ssh 密钥落盘缺尾换行 → 使用时 error in libcrypto，密钥数学关系完全自洽仍失败）。两条写入路径（admin UI、register_access）共用，校验失败 400/ok:false 且零文件 IO——粘贴丢格式（如 ceph keyring 的 TAB 缩进）在保存时就报明确错误，而不是使用时爆 cannot parse buffer
- **能力探针 (capability probe)**（票 10）— provider 可选钩子，登记/保存时核验凭证的**真实权限**与声明档位是否相符（k8s 跑 `kubectl auth can-i` 矩阵——读 pods 必须 yes、写 deployments 按档位定；services/proxy、pods/exec 只做实况标注不卡判——子资源 can-i 可能误报（票 14 的 portforward 教训）；ceph 回读 `ceph auth get` 的 caps 比对，`allow r class-read` 仍算只读、任何含 w 的权限束（rwx/wx 等）算可写；紧 ro 实体无权自读 auth 库（EACCES）会标「无法核验」并自解释——危险方向（超权凭证占 ro 槽）必有足够权限做 auth get，必被抓；ssh 没有可测的只读壳，不实现钩子、档位恒为未核验）。结果以 `probe` 键落在注册表该 tier 旁（status/detail/probedAt，自动管理勿手改），经 listAll 透出到 list_access（`[probe: ro 已核验 / rw 核验失败: …]`；无记录的档位标 声明未核验）和管理 UI（tier 徽章旁的已核验/核验失败/无法核验 chip）。探针只读、失败降级 unverifiable——**从不拒绝写入**；stderr 永不上浮（kubectl/ceph 的报错会带出凭证路径）。`canResolve` 返回类型并入 `AdminTierStatus`（probe 的载体）。
- **消费方 ops-tool-{kubectl,ceph,ssh}** — 模型工具，按名字解析凭证后拼命令。留在 `packages/` 顶层：它们是工具层，不是凭证层

### ops-shell-tool

**命令工具工厂**（`packages/ops-shell-tool`，纯库不是插件）。所有消费方共享的那套机器的唯一事实源：标准结果形状 `{ exitCode, stdout, stderr, command, error? }`、output schema、render、execute 模板（`ctx.get('opsAccess')` 现解析 → buildCommand 拼命令 → `ctx.shell` 执行，30s 超时，信号死亡 exitCode 归一为 -1 **并在 error 字段注明首因，永不裸 -1**（超时杀：含秒数、「操作可能已部分生效」警告、远端显式超时建议；调用方中止：aborted 文案；其他信号杀：透传信号名，SIGKILL 指向 OOM/策略/人为终止——裸 -1 曾让模型把挂死端点误诊为「管道不稳定」，2026-08-27 实战），错误原样透传）。消费方只剩身份四件：工具名、解析的 kind、档案名参数名、`buildCommand`，外加可选的 `stderrNoise`——已知噪音 stderr 行的正则表（如 ceph 容器内缺默认 keyring 的告警），工厂在凭证擦除之后按行过滤，只丢精确匹配的行，其余 stderr 原样保留。`shellQuote` 是导出助手：**ssh 消费方把整条远端命令引成单一参数**（`&&`/`|`/`;`/`$()` 全在远端 shell 解释，本地零切割——2026-08-27 近失事件：未引用时 `&&` 后段会以 root 在本地执行，manifest 恢复链差点断在本地）；kubectl 维持原样拼接（本地管道过滤有用），描述里明示「一次调用 = 一条子命令，`;`/`&&`/`$()` 不继承前缀」。**ceph 消费方按命令首词在 `[ceph, rbd, rados]` 白名单选二进制**（rbd/rados 是独立二进制不是 ceph 子命令——`ceph rbd ls` 的 no valid command found 曾诱使 agent 误诊为权限问题，2026-08-27），不包装的本地二进制（mount/ceph-fuse 等）直接拒绝并指路 ssh 工具；只读性由凭证 caps 在 mon/osd 强制执行，不靠二进制名兜底。

**凭证引用 token（credential reference）**是路径不出日志的统一机制，只在工厂实现一次：buildCommand 用 `ref('字段名')` 标记文件类字段，得到展示 token `<id@tier:field>`（如 `<pf-test-cluster@rw:kubeconfigPath>`）；工厂在执行前把 token 换成 shell 安全引用的真实路径，并把展示命令、stdout、stderr 里所有真实路径的出现一律擦回 token（CLI 报错也会回显 --kubeconfig 路径，只改命令字符串堵不住）。模型和事件日志只看到 token，永远看不到 `/root/.dsh-ops/credentials/...`。

### 登记文件 (access.yaml)

凭证清单的唯一事实源（默认 `~/.dsh-ops/access.yaml`，Config 里只有 `registryFile` 一个路径字段）。按类型分段：`version: 1` 顶字段，段落名是 kind，条目 key 是档案名。**只显式登记，无自动发现**——发现逻辑是退役原型 k8s-plugin.js 里最脆的部分。

**每次解析现读现校验，不缓存**——改完文件立即生效，不用重启（对齐官方 credentials 缝的 per-operation 解析纪律）。

**管理文档走渐进披露**：`help()` 组合出登记文件的管理文档（文件路径、格式、envelope 字段、各 kind 的字段说明——来自提供方的 `fieldsDoc`），agent 通过 `list_access` 的 `help: true` 参数需要时拉取，系统提示词里不放。

### 访问档案 (AccessProfile)

`resolve(kind, name)` 的返回：`{ kind, name, tier, description?, environment?, fields }`。`tier` 是本次实际发放的档位（broker 授权后为 `rw`，否则 `ro`），消费方用它标注凭证引用 token。`description`/`environment` 是所有类型通用的 envelope 字段；`fields` 是提供方 schema 校验+加工后的类型特有字段（k8s 是 `kubeconfigPath`，ceph 是 `conf`/`keyring`/`name?`，ssh 是 `host`/`user`/`key?`/`port?`）。

**安全纪律是结构性的**：fields 里只有路径和连接参数，密钥内容永不过服务的手；连路径也不进日志——命令工具一律以 `<id@tier:field>` token 展示（见上「凭证引用 token」），因此日志、错误信息、模型上下文里天然不会出现秘密，也不出现凭证落盘位置。`list_access` 工具的输出连 fields 都不带——只有 envelope 和 ro/rw 就绪标记（基于 `listAll`，rw-only 条目也可见并标注派生提示）。

### @ 档案引用 (dsh-access mention)

在 web 输入框用 `@` 选中一个档案，落进消息的是结构化 mention `@[kind/name](dsh-access:<base64url>)`（仿官方 `dsh-session:` 模式，编解码在 `ops-access/core/src/mention.ts`）。链路分三段，各在一层：

- **候选路由**：`GET /ops-access/list`（core 包在 preset 平面注册进 host webServer）——基于 `listAll`，envelope-only + 现成 mention + ro/rw 就绪标记；rw-only 条目（ro 未派生）也出现在候选里，选择器标注「ro 未注册（可由 rw 派生）」
- **@ 菜单来源**：`ops-access-ui` 包的 client 半注册 `@` 的 `access` 来源，fetch 这个路由；它的 host 行只为 client bundle 发现而存在（apply 为空）
- **结构化注入**：core 包的 `agent/pre-step` 监听器把 mention 改写成可读的 `@kind/name`，并紧跟注入一条 `<referenced-access>` 消息（envelope-only，找不到的档案降级为提示）

配套：`.dsh-target` 的 profile patch 把官方 `session-reference` 行 disabled 了（@ 菜单的 session 半因此 404 降级为空——**deployment 级**，所有模式都看不到会话来源；恢复就删那行 patch）。按 preset 精细开关需要 dsh 本体给 ui-reference 加 config，未做。

### 教训：外部包不要 runtime import 带模块状态的 dsh 包

外部包的依赖按 monorepo 真实路径解析，和 dsh 本体用的是**两份模块实例**。纯函数（createUserMessage、defineTool）无所谓；带模块私有状态的（typert 的 remote 标记 WeakMap、agent-presets 的 mounts 表）会静默失效——标记记在我们那份，gateway 读它那份。所以 remote 路由走普通 HTTP（webServer.register + fetch），不走 TypertRemoteService。

### 审计门 (Access Gate) — 已实现

按会话代发凭证的授权层。**决策与理由见 `docs/adr/0001-access-gate.md`（授权面板部分见 `docs/adr/0004-access-panel.md`），构建内容见 `docs/specs/0001-access-gate.md`（面板见 `docs/specs/0003-access-panel.md`)**——这里只定义词汇：

- **凭证代发 (credential brokering)** — 门不改基础设施权限，只决定某 session 的工具调用拿到 ro 还是 rw 凭证
- **两档账号 (ro/rw)** — 每环境静态预置只读/可写两套账号；ro/rw 是注册表条目内的 tier 子字段（单一注册表文件，默认 `~/.dsh-ops/access.yaml`，同现读现校验纪律；ADR-0003 由双文件合并而来），ro 档默认可用、rw 档需授权。门注册的 broker 是**纯决策函数**（`(kind, name, agent) => 'ro' | 'rw' | 拒绝`），不碰凭证内容。ssh 不分档，每次使用需授权
- **授权 (grant)** — `{ session, profile, tier, 到期时间, 批准人, 理由 }`。agent 调 `request_access` 显式申请，人一次性批准；TTL 到期自动回落，可手动撤销，重启即清空。审批通道由 ADR-0004 从 dsh 原生 approval 换成自建待决请求通道（原生四态结果不能携带人修改后的 TTL）
- **授权面板 (access panel)**（ADR-0004 / spec 0003，已落地：gate 提供路由与 /access 命令，ops-access-ui 渲染内容，ops-panel 提供外壳）— 人的授权操作唯一入口：会话作用域的自建对话框，敲 `/access`（host 命令）触发，client 半经 `command/executed` 本地事件打开。两个模式：空闲时是主动授权（选档案 → 选 TTL 档位 → 确认）/活跃授权管理面板（**延长**：按档位从现在起续期——不从旧到期点累加，反复续期也不会突破单档上限；过期 grant 不可续、只能重授，审计落 `grant-extend` 并带原到期点；收回单项/全部）；有待决请求时是审批台（可调档位后批准/拒绝）。不做固定设置页——固定页要先选目标会话，与 session 分键模型心智错位。注意路由是 preset-plane：**无活跃会话时 /ops-access/* 不存在**（请求落在 SPA fallback），现场验证路由必须先有一个跑着的会话
- **待决请求 (pending request)**（同上）— agent 提权申请在 gate 进程内的驻留形态：入队后工具 Promise 挂起，人经面板 HTTP 路由裁决（批准可拨 TTL 档位）解出；默认 5 分钟无人裁决自动拒，exec.signal 中止按 cancelled 解出。headless（无 webServer）不入队、立即报错给带外指引
- **面板授权 (panel grant)**（同上）— 人主动发起的授权，与申请批准的 grant **同构同寿命**（session 分键、TTL 有界、重启清空），只是跳过"agent 开口"。TTL 只能选档位（默认 5/10/30 分钟，Config 可配），主动授权与审批共用同一份档位
- **对称通知**（同上）— 命令面不进模型历史，面板的授权/撤销动作由路由往目标 session 追加 model-visible 消息（`<access-grant>`/`<access-revoked>`），agent 立刻感知权限变化。撤销语义：**下一次解析生效，不掐断进行中命令**；面板可一键收回本会话全部授权
- **授权账本 (grant ledger)** — 进程内授权表，按 `exec.agent.id`（= session id）分键；`exec.agent` 缺失时由 broker 裁决：两档 kind 回落 ro，ssh 类直接拒绝（ssh 凭证本质是 rw——没有真只读 shell——无会话可键权就不发）。apply（启动与 HMR 重载）即清空账本
- **审计日志** — 授权（批准/续期/到期/撤销）、rw 代发、账本重置（`ledger-reset`，启动与 HMR 各落一行）逐条落 JSONL 文件（默认 `~/.dsh-ops/audit.log`），不进 session 事件流。**完整性声明限定为「经门控工具的操作」**：持通用 bash 的 agent 可绕过门（读宿主机密钥自跑 ssh/kubectl），绕道操作只进 session 事件流（ADR-0001 §1 补记）；主要缓解是把门控工具修可靠让绕道失去动机，而非堵 bash

### 凭证管理 UI (Access Admin UI)

浏览器侧录入、删除、验证 ro/rw 凭证条目的设置页（`settings.section` 插槽）。**决策见 `docs/adr/0002-access-admin-ui.md`，构建内容见 `docs/specs/0002-access-admin-ui.md`**——这里只定义词汇：

- **id 与名称 (id vs display name)** — 条目的注册表键是 **id**：可读但稳定，进文件路径（`credentials/<kind>/<id>/<tier>/<field>`）、@-mention、工具参数、授权账本、关联引用，创建后不可改。`name`（envelope 字段）是**显示名**，只用于 UI 和 list_access 展示，随时可改、不触发任何文件移动。id 格式受限：字母/数字开头，可含 `. _ - @`（writeEntry 入口校验，防路径逃逸与 mention 语法破坏）
- **凭证内容粘贴 (content paste)** — 文件类字段（provider 声明的 `fileFields`）在 UI 里直接粘贴凭证内容（kubeconfig、ceph.conf、keyring、私钥），core 落盘到 credentials 目录、注册表只存路径；用户从不接触宿主机路径。**只写不回读**：保存后内容永不回读——getEntry 只回非文件字段 + 文件字段的「已保存」布尔标记（连路径都不回），编辑表单该字段留空、占位提示「已保存 · 内容不可回读——粘贴新内容以覆盖」；留空提交=保留（服务端 carry-over 存回旧路径），粘贴新内容=覆盖
- **envelope-only 列表** — 列表 API 只返回 kind/name/description/environment + 验证状态，不含 fields。和 `list_access` 工具的纪律一致；编辑回读（getEntry）是给人类操作员的显式例外
- **凭证条目验证 (entry validation)** — 用现有 `canResolve` 机器（存在性 + provider schema 校验），返回 `AdminTierStatus`（`{ ok, error?, probe? }`）。条目验证本身不做联网探针——真实权限核验是独立的**能力探针**机制（见上方词条，票 10 起）：canResolve 只填 ok/error，探针结果由 listAll 从注册表 tier 旁的 `probe` 键挂上
- **core 读写 (core read-write)** — core 从只读变读写，`OpsAccess` 接口增加 `writeEntry`/`deleteEntry`/`getEntry`/`listAll`。core 是注册表的唯一管理者，写入复用现有 `loadRegistry`/`buildProfile` 的 parse + validate 机器。写入路由在 preset 平面注册（和 `GET /ops-access/list` 同位置）
- **kind 描述符 (KindDescriptor)** — `{ kind, jsonSchema, fieldsDoc?, fileFields? }`，通过 zod v4 的 `z.toJSONSchema()` 序列化 provider 的 zod schema 为标准 JSON Schema，前端据此动态渲染表单字段；fileFields 字段渲染为内容粘贴文本框
- **派生注册 (derived registration)** — agent 持 rw 凭证在基础设施上自助创建只读账号（命名约定：k8s ServiceAccount `<id>-ro`、ceph `client.<id>-ro`），再调 **`register_access`** 工具把派生凭证写入 ro 档。不设授权门槛：ro 档是 agent 默认工作面，人可随时在管理 UI 注册/覆盖；rw 档永远只能人注册（工具只写 ro，kind/id 缺失时整条新建）。每次注册随工具调用进 session 事件流，可重建。各 kind 的派生配方是 provider 的 `derivationDoc`（prose 而非代码——命令随基础设施版本漂移，由 agent 用判断力执行），经 `list_access help: true` 按需拉取。文件类字段内容与 UI 粘贴共用同一落盘机器（`writeContentFiles`，0600，根目录可配 `credentialsDir`，默认 `~/.dsh-ops/credentials`）。配套可发现性：rw-only 条目在 @ 菜单、list_access、mention 注入三处都可见并标注「可派生」；`request_access` 对两档 kind 只要求 rw 档可解析（ro 缺失正是派生引导场景，若卡 ro 检查会死锁）；ro 缺失且 rw 存在时 resolve 的报错直接指向 register_access

- **封禁 (deny 第四态)**（票 12）— 运维对某 profile 的显式锁：broker 裁决的第一道检查，连 ro 档也拒发（场景：凭证泄露、维护期、事故冻结）。与授权的三处本质区别：进程级而非会话级、**持久化**到 `~/.dsh-ops/denied.json`（重启不悄悄解冻）、封禁瞬间连带收回所有会话的该档案授权并通知。面板档案行红点 + 封禁/解封两段确认；审计事件 `deny`/`undeny`/`deny-block`；被封档案上的 request_access 直接快速失败（不挂起）。

## 环境清单 (Environment Inventory)

### 环境清单 (environment inventory)

只读的环境地图，构建内容见 `docs/specs/0004-environment-inventory.md`。遍历 ops-access 注册的 k8s 集群，从 k8s API 盘出「集群 → 命名空间 → 中间件实例/应用 → 尽力而为的关联边 + Prometheus 监控状态」，落盘为 `~/.dsh-ops/environment.yaml`（自动生成、勿手改）。有 rook-ceph 足迹的集群额外带 **ceph 提示**（CephBlockPool 池名——即 ceph 工具的 `-p` 参数、CephCluster、rook-ceph-tools pod 位置；无 tools pod 会明写，缺席本身是有用信息），降级纪律与 endpoints 一致：CRD 不存在或 ro 档无权 list 就不带该段，扫描不受影响。agent 通过 preset 平面的 `environment` 工具消费（overview / show / refresh），系统提示词只放一句引导。

### 盘点 (scan)

清单的生成过程。**纯确定性代码**（list + 分类表归类 + 写文件），零 LLM 参与——同一集群扫两次结果必须一致，这是清单能当地图用的前提。LLM 只消费清单做推理。

### 新鲜度纪律 (TTL + stale)

清单段带盘点时间戳，TTL（默认 1 小时）过期自动重扫，agent 可用 `refresh` 显式重扫；会话启动不阻塞、读缓存。集群连不上时**保留旧数据并标记 stale**，整块缺失或报错都是事故。

### 识别分类表与 unknown 桶

中间件识别靠镜像名/chart 名/label 的分类表：常见中间件内置代码，用户规则文件（`~/.dsh-ops/` 下）可追加覆盖。识别不出的工作负载进 **unknown 桶**——照常列出名称与镜像，不从视野消失。

### 关联边 (relation edge)

「谁连谁」的边。**尽力而为**：粗粒度（应用 ↔ 集群 ↔ 中间件）必须准；细粒度靠解析 ConfigMap 与明文 env 的值连边（如 `*.svc.cluster.local` 模式）。**Secret 只记引用名、绝不读值**——凭证材料不进清单、日志、模型上下文，与凭证体系同一条底线。更深的下钻留给排查时的 kubectl 工具现场做。

### 监控状态印证 (Prometheus corroboration)

盘点时尝试发现集群内 Prometheus service，经 `kubectl port-forward` 读 targets API，把 up/down 附到清单条目上，与 k8s 数据互相印证。找不到就跳过，是增强项不是硬依赖。agent 主动加监控点位是后续方向，不在本期。

### 异常标注 (anomaly)

清单段的规则检测异常（`src/anomalies.ts`，纯 k8s 通用语义零 LLM）：`cross-namespace-ref`（工作负载引用别的命名空间的 Service，info 级）和 `service-no-backend`（Service 有 selector 但 Endpoints 零就绪地址，warning 级——endpoints 是权威答案，不从 fronts 边反推）。overview 单列一节，show 就地标注。规则代码禁止出现任何环境特定名字，通用性由合成陌生环境夹具（tests/fixtures/shop-cluster）证明。

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

- **complete / resolve（带 summary）= 证实、正面关闭**：记录结论。两者等价——resolve 是领域语言直觉（"resolve 一个假设"），complete 保留为别名；打在任意非 goal 节点上都只关闭该节点
- **abandon = 证伪**：死路留在树上
- **start / reopen**：进入 / 回到进行中
- **resolve 打在 goal 上 = 全案收口**：只调一次，标记最终目标达成，树转入历史。**硬门槛**：所有非根节点必须先定论（done/dead_end），否则拒绝并列出未定论节点，引导先 complete/abandon；`force: true` 是「调查中途放弃」的显式逃生口（维持 WARN 放行）。约束只放在 goal 收口这一处——step complete 时不做任何「提示收口 milestone」的逻辑，避免早收口压力抑制下钻。只有这一发会置树级 `resolved` 标志（活跃树判定的唯一依据）

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

### ops 专属 skill

面向运维场景的纪律性方法论，按 skill 结构组织：**catalog 常驻 name+description（写成触发路由文案），正文经 `skill` 工具按需拉取**——走 dsh 原生 skill 子系统，不另建通道。载体是纯文本 Markdown + 原生 frontmatter（`name`/`description` 必填，`whenToUse` 可选；重操作 skill 用 `disable-model-invocation: true` 退出模型 catalog，只留用户 `/name` 显式触发——remediation 就是这个姿态）。两个来源：ops-prompts 以 **bundled skill provider**（`ops-prompts-bundled`）提供仓库版 skill（包内 `skills/` 目录，remediation 住这里）；用户/团队 skill 走 `skill-filesystem` 的原生目录分级。**纯提示词 skill 是文本文件，不是包**——被打包成插件的只有和工具耦合的 skill（trace 那种 doctrine 常量被代码多处引用的）。现有成员：trace（结构化排查，包内）、environment（环境认知，包内 prompt 半）、remediation（修复变更，文本 skill，spec 0005)。纪律守不住的部分才固化成插件代码——skill 先行，代码兜底。

### 提醒规则与锁存器 (Reminder / ReminderLatch)

trace 有两条提醒规则，都是**纯函数**（输入提醒上下文，输出文案或 null）：

- **idle** — 活跃调查 5 步没更新 trace 时催促
- **nesting** — step 全部平铺在 milestone 下（深度判定：≥3 个深度 2 节点且无更深）且已有 step 带发现完成时，提醒下钻

**锁存器** 保证不刷屏：单调版本号（历史重放不会重新武装规则）+ 触发间隔 + 每会话触发上限。无限循环事故的教训就固化在这里。间隔可以是次数的函数——**idle 用带天花板的退避 + 服从复位**：首响后 5 步，之后 10、20、40 翻倍但 **40 步封顶**（再长的会话也保有每 40 步一次的接触底线，永不永久静默）；且 agent **响应了提醒**（在上次触发位置或之后更新过 trace）就复位退避级数，下一段空窗从 5 步重新开始——好行为不被拉长的间隔惩罚。触发上限 1000 是防失控摆设，不是防刷屏机制。防刷屏防的是频率，不是总预算（2026-08-27 实测教训：固定上限 5 次在 176+ 步调查的前 70 步烧完，之后 36 步无提醒裸奔）。nesting 维持固定间隔 1、上限 5（它语义上是「树形状变了才值得再响」）。

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
