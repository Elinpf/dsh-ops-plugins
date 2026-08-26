---
title: 凭证管理 UI（ops-access-admin-ui）— 浏览器侧录入、删除、验证 ro/rw 凭证条目
status: proposed
date: 2026-08-26
adr: docs/adr/0002-access-admin-ui.md
---

# 凭证管理 UI（Access Admin UI）Spec

## Problem Statement

ops-access 的凭证档案目前全靠手编 YAML 注册表（当时为 access.yaml 和 access-rw.yaml 双文件；ADR-0003 已合并为单文件）。手编的痛点是：填错了字段只有 agent 真正尝试 resolve 时才炸（或者申请授权被门拒绝时才知道 rw 条目不存在）；rw 文件对人不可见、没有校验入口；加一个新 kind 的条目要去翻 provider 的 fieldsDoc 文档才知道要填什么。运维工程师需要一个浏览器界面：录入凭证条目、选 ro 或 rw 档位、即时校验"这个条目真的能解析"，不用手编 YAML 不用重启。

## Solution

在 dsh 设置页（settings.section 插槽）增加一个"凭证管理"页面，由 ops-access-ui 包的 client bundle 携带。core 包从只读变读写——OpsAccess 接口增加写入/删除/列全量/列 kind 方法，preset 平面注册对应的 HTTP 路由。验证复用现有 canResolve 机器（存在性 + provider schema 校验），返回带失败原因的验证结果。

安全纪律：列表 API 只返回 envelope（kind/name/description/environment）和验证状态，不含 fields。条目的注册表键是稳定 id（进路径、mention、授权、关联引用，创建后不可改，格式受限：字母或数字开头，可含 . _ - @）；显示名是 envelope 的 name 字段，随时可改。文件类字段的值是凭证内容本身——浏览器粘贴内容，core 落盘到 credentials 目录、注册表存路径；编辑模式通过 getEntry 读回内容预填（面向人类操作员的显式例外）。kind 列表和 provider 的字段结构通过 zod v4 的 z.toJSONSchema() 序列化为标准 JSON Schema 发到前端，动态渲染表单字段。

## User Stories

1. 作为运维工程师，我希望在设置页看到所有已登记的凭证条目，这样我不用去终端 cat 文件。
2. 作为运维工程师，我希望每个条目能看到它在 ro 档和 rw 档分别是否存在、是否校验通过，这样一眼就知道哪档配好了哪档缺。
3. 作为运维工程师，我希望校验失败时能看到原因（如"kubeconfig: field is required"），这样我能直接修。
4. 作为运维工程师，我希望在 UI 里新增一个凭证条目，选好 kind、直接粘贴凭证内容（如 kubeconfig 文件内容）、按需填 ro 和 rw 两档，提交后条目就写进注册表，这样不用手编 YAML、不用碰宿主机文件。
5. 作为运维工程师，我希望填写表单时根据 kind 自动渲染正确的字段输入框（k8s 是 kubeconfig，ceph 是 confPath/keyringPath/name，ssh 是 host/user/keyPath/port），每个字段标注是否必填，这样我不用去翻文档。
6. 作为运维工程师，我希望表单里能填 description 和 environment 这两个 envelope 字段，这样条目的展示信息完整。
7. 作为运维工程师，我希望保存条目后即时校验——UI 显示"✓ ro 能解析 / ✗ rw 未配置"，这样我知道写进去了没有、对不对。
8. 作为运维工程师，我希望保存后表单清空回到列表视图，fields 值从屏幕消失，这样凭证字段不会留在浏览器里。
9. 作为运维工程师，我希望删除一个过期的凭证条目（点删除 + 确认），这样不用去终端改文件。
10. 作为运维工程师，我希望删除时有一个确认框防误操作，这样不会手滑删掉生产凭证。
11. 作为运维工程师，我希望选 kind 时下拉列表是动态拉取的——只显示当前已注册 provider 的 kind，这样不会选到一个没有 provider 的 kind。
12. 作为运维工程师，我希望填写字段值时 UI 给出字段类型提示（字符串 vs 数字，如 ssh 的 port 是数字），这样不会填错类型导致校验失败。
13. 作为运维工程师，我希望保存后切走再回来时只看到条目名和验证状态，不看到字段值，这样凭证信息不在浏览器里留存。
14. 作为管理员，我希望 rw 凭证的 fields 路径永远不出现在浏览器侧，这样 rw 文件的结构信息对 agent 不可见。
15. 作为管理员，我希望写入操作走 core 服务（core 是两个文件的唯一管理者），这样写入逻辑和读取校验用同一套代码，不会手写第二份 YAML 解析。
16. 作为管理员，我希望写入路由在 preset 平面注册（和现有 GET /ops-access/list 同位置），这样不跨 plane 访问带状态的服务，避免双模块实例问题。
17. 作为管理员，我希望 canResolve 的返回从 boolean 变为 { ok, error? }，这样验证失败的原因能传到 UI 给人看。
18. 作为管理员，我希望 gate 的 request_access 预检在 canResolve 返回类型变更后仍正常工作，这样授权流程不受影响。
19. 作为运维工程师，我希望 UI 用 dsh 的主题变量和设计系统，这样在明暗色模式下都正常。
20. 作为运维工程师，我希望 UI 在 ops-access 服务不可用时优雅降级（显示空列表或提示），这样不会因为没挂 ops preset 就白屏。

## Implementation Decisions

### 涉及的包和角色

- **ops-access/core**（preset 平面）— 从只读变读写。OpsAccess 接口增加写入能力，注册新的 HTTP 路由。core 是两个凭证文件的唯一管理者（ADR-0001 决策 6），写入归它管是一致的延伸。
- **ops-access/gate**（preset 平面）— 适配 canResolve 返回类型变更。gate 的 request_access 预检调 canResolve（2 处），从 if (!await canResolve(...)) 变为 if (!(await canResolve(...)).ok)。
- **ops-access-ui**（host 平面薄壳）— client bundle 增加设置页面的 React 组件。apply 仍为空（只为携带 client bundle），新增的 settings.section 注册在 client 侧。

不新建包——三件事都是现有包的自然延伸。

### core 接口变更

OpsAccess 接口新增方法：

- writeEntry(kind, name, tier: "ro" | "rw", fields: Record<string, unknown>, envelope?: { description?, environment? }): Promise<void> — upsert 语义：条目存在则覆盖，不存在则新增。读现有文件 → 合并条目 → 写回。写入后走 buildProfile 校验（复用现有 parse + validate 机器），校验失败则不写文件并抛错。fields 是 provider schema 校验后的类型特有字段（不含 envelope 字段——description/environment 分开传）。
- deleteEntry(kind, name, tier: "ro" | "rw"): Promise<boolean> — 删除一个条目。读现有文件 → 删条目 → 写回。返回是否删除了（条目不存在返回 false）。文件不存在返回 false。
- listAll(): Promise<AdminEntry[]> — 合并 ro + rw 两档的条目清单，按 kind/name 合并。每个条目带 envelope（kind/name/description/environment）+ 两档验证状态 { ro: { ok: boolean, error?: string }, rw: { ok: boolean, error?: string } }。不带 fields。两档分别读文件、交叉比对。
- listKinds(): Promise<KindDescriptor[]> — 返回已注册 provider 的 kind 列表，每个带 { kind: string, jsonSchema: object, fieldsDoc?: string }。jsonSchema 通过 z.toJSONSchema(provider.schema) 序列化。

canResolve 返回类型变更：

- 从 canResolve(kind, name, tier): Promise<boolean> 变为 canResolve(kind, name, tier): Promise<{ ok: boolean, error?: string }>
- 现有实现的 catch 块改为捕获错误消息并放入 { ok: false, error: message }，成功返回 { ok: true }
- gate 的 2 处调用适配新返回类型

AdminEntry 和 KindDescriptor 类型：

```
interface AdminEntry {
  kind: string
  name: string          // stable id (registry key)
  envelope: {
    name?: string       // display name, editable
    description?: string
    environment?: string
  }
  tiers: {
    ro: { ok: boolean, error?: string }
    rw: { ok: boolean, error?: string }
  }
}

interface KindDescriptor {
  kind: string
  jsonSchema: object   // standard JSON Schema from z.toJSONSchema()
  fieldsDoc?: string
  fileFields?: string[]  // fields whose value is credential file content
}
```

### HTTP 路由变更（全部 preset 平面，core 包 apply 内）

现有路由：
- GET /ops-access/list — 保留，行为不变（envelope-only 候选 + mention，@ 菜单用）

新增路由：
- GET /ops-access/admin/list — 返回 listAll() 的结果（AdminEntry[]，含两档验证状态，不含 fields）
- GET /ops-access/admin/kinds — 返回 listKinds() 的结果（KindDescriptor[]，含 JSON Schema）
- POST /ops-access/admin/entry — body: { kind, name, tier, fields, contentFiles?, description?, environment? }；contentFiles 里的文件内容先落盘到 ~/.dsh-ops/credentials/<kind>/<name>/<tier>/<field> 再以路径写入 fields，然后调 writeEntry()，返回 { ok: boolean, error?: string }
- DELETE /ops-access/admin/entry — query: ?kind=...&name=...&tier=...，调 deleteEntry()，返回 { ok: boolean, error?: string }

所有路由的响应和错误信息不含 fields 值——fields 只在 POST 的请求体里从浏览器流向服务端，不回流。

### ops-access-ui client 变更

src/client.ts 增加 settings.section 注册：

- ctx.slots.inject("settings.section", ...) 注册一个 id 为 ops-access-admin 的设置页
- 组件用 React.createElement 构建（和 trace dock 同模式，不引入额外框架）
- CSS 用主题变量（var(--dsw-alias-*)），和 trace dock 同模式

页面结构：

- 列表视图：按 kind 分组的卡片，每卡片内每行一个条目（name/description/environment + ro/rw 验证图标），刷新按钮，新增按钮
- 表单视图：kind 下拉、profile name、description/environment 在上；下方按档位分 ro / rw 两个区块，每区块按 kind 的 JSON Schema 动态渲染字段，文件类字段（fileFields）渲染为多行文本框直接粘贴凭证内容；提交时对每个填了内容的档位各发一次写入
- 凭证内容粘贴：文件类字段的值是凭证内容本身，由 core 写入 ~/.dsh-ops/credentials/<kind>/<name>/<tier>/<field> 并把路径存进注册表，路径对用户不可见。**只写不回读**：保存后内容永不回读——getEntry 只回非文件字段 + 文件字段的「已保存」布尔标记（连路径都不回）；编辑表单该字段留空并提示「已保存 · 内容不可回读——粘贴新内容以覆盖」，留空提交=服务端 carry-over 保留旧路径，粘贴新内容=覆盖
- 校验状态：提交后刷新列表，每条显示 ro/rw 的 ok/error
- 删除：每行一个删除按钮，点击弹确认框；删除某档时同步清理该档的凭证内容文件

数据流：

- 列表：fetch GET /ops-access/admin/list → 渲染表格
- 新增表单：fetch GET /ops-access/admin/kinds → 渲染 kind 下拉 + 动态字段表单
- 提交：fetch POST /ops-access/admin/entry → 成功后回到列表视图
- 删除：fetch DELETE /ops-access/admin/entry → 成功后刷新列表

### zod schema 序列化

provider 的 zod schema 是简单的 zod.object({...})（k8s 一个字段、ceph 三个、ssh 四个），zod v4（^4.4.3）内置 z.toJSONSchema() 可直接序列化为标准 JSON Schema。core 的 listKinds() 遍历 providers Map，对每个 provider 调 z.toJSONSchema(provider.schema)。

### 安全纪律（延续 ADR-0001）

- **只写不回读**：表单永远空表单，不回填旧 fields 值。保存后回列表视图。rw fields 永远不流向浏览器。**文件类字段的内容任何档位都不回读**（getEntry 只回 set 标记）——admin 路由无鉴权，能摸到路由的人/脚本不能借此搬空凭证库。
- **envelope-only 列表**：列表 API（listAll / GET /admin/list）只返回 kind/name/description/environment + 验证状态，不含 fields。和现有 GET /ops-access/list 的纪律一致。
- **写入走 core**：core 是两个文件的唯一管理者，写入复用 loadRegistry/buildProfile 的 parse + validate 机器，不手写第二份 YAML 逻辑。
- **路由在 preset 平面**：和现有 GET /ops-access/list 同位置，避免跨 plane 访问带状态服务的双模块实例问题。
- **错误信息不含秘密**：验证失败的 error 来自 zod 校验输出（字段路径 + 消息），fields 只是路径和连接参数，没有密钥内容。和现有 resolve 的错误纪律一致。
- **删除不查授权**：删除只管删文件条目，不跨 plane 查 preset 的活授权。授权回落交给门的 TTL（短命）。

### 删除时的授权行为

删除 rw 条目后，如果有 session 正持着该 profile 的活授权（grant），文件删了但 grant 还在（进程内账本），下次 resolve 才炸（"no rw credential is registered"）。这是可接受的行为——威胁模型是防犯傻不是防作恶，删除是人为有意操作；grant 的 TTL 本就短命。UI 只做浏览器侧确认框（"确定删除 k8s/prod 的 rw 条目？"），不做跨 plane 授权检查。

### register_access 工具（agent 自助注册 ro 档）

人注册 rw 档之后，agent 可用 rw 凭证在基础设施上派生只读账号并自助写入 ro 档：

- **工具形态**：core 在 preset 平面注册 `register_access`（inject tools），参数 `{ profile: "kind/id", fields, description?, environment? }`。文件类字段（provider 的 fileFields）传**内容**，走与 UI 粘贴同一台 `writeContentFiles` 落盘机器；其余字段内联存储。条目不存在时整条新建（upsert 语义复用 writeEntry）。
- **只写 ro**：rw 档永远由人经管理 UI 注册/覆盖，工具写不到。注册不设授权门槛（决策：ro 是 agent 的默认工作面，自助补齐；人随时可覆盖修正）。每次注册随工具调用进 session 事件流，可重建。
- **派生配方**：provider 新增 `derivationDoc`（prose，含命名约定 k8s `<id>-ro` / ceph `client.<id>-ro`），由 help() 经 `list_access help: true` 按需拉取。配方不落代码——命令随基础设施版本漂移，由 agent 用判断力执行。
- **内容落盘加固**：`writeContentFiles` 只接受 provider 声明的 fileFields（其余拒绝）、字段名字符集守卫（防路径逃逸）、一律 0600。落盘根目录可配 `credentialsDir`（默认 `~/.dsh-ops/credentials`，测试隔离用）。
- **配套可发现性**：rw-only 条目（人注册了 rw、ro 未派生）在 @ 菜单、list_access、mention 注入三处都可见并标注「可派生」——`GET /ops-access/list` 与 mention 渲染改用 `listAll`，list_access 输出带 ro/rw 就绪标记。`request_access` 预检对两档 kind 只要求 rw 档可解析（ro 缺失正是派生引导场景，卡 ro 检查会死锁）；ssh 类仍查 ro（凭证本体在 ro 档）。ro 缺失且 rw 存在时 resolve 报错直接指向 register_access。

## Testing Decisions

### 后端逻辑测试（ops-access/core/tests/）

照抄现有 harness 模式（core/tests/harness.ts 的 setup() —— 启动插件 + 临时凭证文件 + 捕获路由）。扩展现有 ops-access.spec.ts，新增测试组：

- **writeEntry**：upsert 新条目 → 文件写入 → resolve 能拿到 → 字段正确；upsert 覆盖已有 tier → 旧 tier 值被覆盖、envelope 保留；schema 校验失败 → 不写文件 + 抛错；注册表文件不存在 → 创建文件；非法 id（路径逃逸、含斜杠/空格等）→ 拒绝写入
- **deleteEntry**：删除已有条目 → 文件更新 → resolve 抛 "not found"；删除不存在的条目 → 返回 false；文件不存在 → 返回 false
- **listAll**：ro 有 rw 没有 → 该条目 ro.ok=true rw.ok=false；schema 校验失败的条目 → ok=false + error 有原因；同一条目 ro/rw 两级 → 合并为一行两个 tier 状态；envelope（含显示名）字段正确传递；响应不含 fields
- **listKinds**：返回所有已注册 provider 的 kind + jsonSchema；jsonSchema 包含字段名和 required 标记；未注册 provider 的 kind 不出现
- **canResolve 返回 { ok, error? }**：成功 → { ok: true }；schema 失败 → { ok: false, error: "..." }；文件不存在 → { ok: false }；不咨询 broker（回归）
- **新路由**：GET /admin/list 返回合并视图；GET /admin/kinds 返回 kind 列表 + schema；POST /admin/entry 写入成功；DELETE /admin/entry 删除成功；所有路由响应不含 fields 值
- **register_access**：content → 0600 落盘 + 注册表存路径；条目缺失时新建；rw 档与 envelope 保留；空串清 envelope；坏 profile/未知 kind/schema 失败 → ok:false 且不写注册表；help() 含 derivationDoc；POST contentFiles 拒绝未声明字段与路径逃逸字段名

### gate 回归测试（ops-access/gate/tests/）

照抄现有 harness 模式（gate/tests/harness.ts）。现有测试中 canResolve 的断言从 toBe(true/false) 变为 toEqual({ ok: true }) / toEqual({ ok: false, error: ... })。request_access 的可交付性预检路径仍正常工作（批准 → 入账 → resolve 发 rw）。

### 浏览器半边测试（ops-access-ui/tests/）

照抄现有 spec 模式（ops-access-ui.spec.ts —— mock fetch + mock slots context + 驱动 client 注册和调用）。新增测试组：

- **settings.section 注册**：apply 后注册了一条 id="ops-access-admin" 的设置页
- **列表 fetch**：mock fetch 返回 AdminEntry[]，组件发起 GET /ops-access/admin/list
- **kinds fetch**：mock fetch 返回 KindDescriptor[]，组件发起 GET /ops-access/admin/kinds
- **写入 fetch**：mock 表单提交，组件发起 POST /ops-access/admin/entry，body 含 fields 不含回读
- **删除 fetch**：mock 删除操作，组件发起 DELETE /ops-access/admin/entry
- **降级**：路由 404 / 网络失败 → 优雅降级（空列表或提示）

### behavioral 验证

.dsh-target 真实 session 走完整链路：打开设置页 → 看到凭证列表 → 新增条目 → 选 kind → 填字段 → 选 ro/rw → 提交 → 看到验证状态 → 删除条目。单测替代不了，对齐仓库现有工作流。

## Out of Scope

- 审批面板（A/B/C 中的 A）—— spec 第 82 行标为"审批面板二期再谈"
- 授权面板/dock（A/B/C 中的 B）—— 后续做
- 真实权限探针（canResolve 之外的 k8s auth can-i 自检）—— ADR-0001 第 93 行标为"候选方向、未定案"
- 防主动作恶的建设（威胁模型 A）
- rw fields 回读编辑（只写不回读，已定）
- 删除时跨 plane 查活授权（交给门 TTL）
- 凭证条目版本历史/回滚

## Further Notes

- ADR-0001 决策 6 "双文件归 core，门只做决策"——core 增加写入能力是该决策的自然延伸，core 本来就是两个文件的唯一管理者。但"core 从只读变读写"是 hard-to-reverse + surprising（未来读 core 代码的人会看到它既能读又能写凭证文件），需要记 ADR-0002。
- CONTEXT.md "审计门" 一节需增加凭证管理 UI 相关词汇。
- zod v4 的 z.toJSONSchema() 是标准 JSON Schema 输出，前端可用通用 JSON Schema 表单渲染逻辑处理。三个 provider 的 schema 都是简单的 flat object（无嵌套、无 union），序列化无障碍。
- ops-access-ui 的 esbuild externals 列表可能需要增加 @deepseek-ai/dsh-client-ui-slots（如果 settings.section 的 inject 需要它）。当前 externals 已包含此包。
- 现有 GET /ops-access/list 路由保持不变——它是 @ 菜单的数据源，返回 envelope + mention。新的 GET /ops-access/admin/list 是凭证管理专用的合并视图，两者并行。