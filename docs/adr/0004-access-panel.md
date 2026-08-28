# ADR-0004: 授权面板与自建审批通道 —— 人的主动授权入口，弃用原生 approval

- 状态：已接受（设计定稿，构建内容见 docs/specs/0003-access-panel.md，尚未实现）
- 日期：2026-08-27
- 背景会话：/grill-with-docs 烤问，覆盖主动授权入口、弹框机制选型、审批粒度、撤销语义、headless 行为

## 上下文

审计门（ADR-0001）落地后，授权面只有一个入口：agent 调 `request_access`，人通过 dsh 原生 approval 弹窗一次性批准。三个痛点在真实使用中浮现：人不能**主动**授权（知道接下来要干写操作，也得等 agent 开口再点弹窗）；审批**粒度太粗**（agent 要 60 分钟，弹窗只有给/拒，人不能改成 10 分钟）；人没有**撤销入口**（只有 agent 自己能撤自己会话的 grant）。同时四个候选场景（预先授权 / 跨会话总览 / 常驻策略 / 封禁）被确认都是真需求，但要分步落地。

## 决策

### 1. 人的授权入口是会话作用域的自建对话框，不做固定设置页

gate 注册 host 命令 `/access`（`ctx.commands.register`，handler 为空操作，生命周期 log-only）；ops-access-ui 的 client 半监听浏览器本地事件 `command/executed`（dsh 文档明说的"浏览器专属副作用"通道）打开自建 overlay 对话框。对话框是会话作用域的——在哪个会话敲 `/access` 就操作哪个会话的授权，天然契合"grant 按 session 分键"的账本模型，"授权给谁"这个问题不复存在。

否决了固定 web 面板页：它要先回答"枚举所有会话、选一个当目标"，而 grant 的键是 session id，心智错位。也否决了复用 ui-commands 的 popupSelect 外壳：契约是严格单层的（options 开时加载一次，select 即关），"选档案 → 选 TTL"的两步交互放不进去；拍平成"档案 × TTL 档位"的 3N 行太丑；hack 内部层 `popupFor()` 手动重开第二层会破坏 token 消费（`/access` 文本残留输入框），不做。

### 2. request_access 弃用 ctx.approval，gate 自建待决请求通道

原生 approval 通道的结果词汇是封闭四态（allowed-once/rejected/cancelled/unavailable），**批准时不能携带修改后的参数**——人无法把 60 分钟改成 10 分钟。自定义 answerer（`approval/request` waterfall 监听器）被否决：dsh 文档明说兄弟监听器顺序不是策略优先级机制，我们会和内置 web answerer 抢单。

改为：agent 调 `request_access` → gate 把请求挂进进程内**待决队列**，工具 Promise 驻留（绑 exec.signal 中止）→ web 端轮询发现待决请求自动弹出审批对话框 → 人看到档案、agent 理由、可调的 TTL 档位，批准（可改档位）或拒绝 → 路由裁决解出 Promise → 工具结果告知 agent 最终批准的 TTL。原生 approval 通道留给 dsh 自己的用途（bash 提权等），我们不再消费它。这推翻了 ADR-0001 决策 5 的"审批交互用 dsh 原生通道，不自造"——当时没有参数修改需求，原生通道够用；现在不够用，且自建通道与自建面板本是同一份基础设施。

### 3. TTL 档位化，审批可调

TTL 选项固定为档位列表（默认 `[5, 10, 30]` 分钟，Config 可配），主动授权和审批共用同一份档位。审批对话框的档位选择器默认停在 agent 请求的值，人拨档后批准；工具结果如实告知 agent 实际批准的档位（"人把 60 分钟调整成了 10 分钟"）。maxTtlMinutes 仍是上限。档位而非自由输入：防呆，且让审计日志的 TTL 分布可读。

### 4. 待决请求有超时；headless 快速失败

待决请求默认 5 分钟（Config 可配）无人裁决自动拒，审计落决定行——人不在电脑前时 agent 不无限挂起。headless 部署（无浏览器）判别式是 `ctx.get('webServer')` 缺失——gate 的人侧路由本就注册在 webServer 上，路由无处注册即无审批通道，request_access 立即报错并给带外指引，不等超时。行为与现状等价（原生通道在 headless 同样批不出来），审计反而变好：申请与超时决定都落行，此前这笔拒绝在审计里不可见。

### 5. 授权与撤销对称通知 agent

命令面永远不进模型历史（dsh 契约），所以面板的动作 agent 无从感知。路由在写账本/撤账本后，往目标 session 追加一条 model-visible 消息（`<access-grant>` / `<access-revoked>`，走 mention 注入同款路子），满足 model-visible ⟺ logged。授权不通知，agent 按只读思路绕路；撤销不通知更糟——它按"我有写权限"的计划走到一半，下一次调用突然回落 ro。对称通知让 agent 能立刻调整计划。

### 6. 撤销语义：下次解析生效，不掐断进行中命令；面板可一键全收

broker 每次解析现问账本，撤销从下一次工具调用生效；已发出的命令跑完不受影响——"撤销即 kill"要动命令生命周期，是另一个量级的事，不做。面板活跃 grant 列表底部有「收回本会话全部授权」行（带确认门），紧急场景一键清场，审计逐条落 revoke 行。agent 侧的 `request_access action: 'revoke'` 保留——干完写活主动交还是好卫生习惯。

### 7. grant 模型本身不动

面板授权（人主动发起）与申请批准产生的 grant **同构同寿命**：按 session 分键、TTL 有界、重启清空账本、broker 决策逻辑不变。面板只是跳过"agent 开口"这一步，不写第二种 grant。这保证第一刀不引入第二套生命周期语义。

### 8. 面板机制独立成包（ops-panel），提供公共抽象服务

对话框的外壳机制（命令触发、`command/executed` 分发、overlay 外壳、每会话开关状态）与授权业务分离，独立为新包 **ops-panel**：client 半 `ctx.provide('opsPanels', ...)` 提供注册服务（key 复数 = registry），node 半只出无状态的 `registerPanelCommand` helper 和词汇类型。消费方（授权面板是第一个）只剩四件身份：命令名、面板标题、内容组件、可用性过滤器——对齐 ops-shell-tool 的"消费方只剩身份四件"哲学，但形态不同：**不能是纯库**（双模块实例教训：N 个消费方 bundle 各打包一份 = N 份注册表、N 个事件监听、N 个外壳互撞），必须是 cordis 服务，DI 保证单实例。先例是 dsh 自己的 ui-commands（`ctx.commandUi`）：我们的面板缝是它的"完整对话框"档——popupSelect 单层契约装不下的那一层。

反向检查（"只有一个调用方的公开服务 = 过度设计"）记录在案：当前确实只有授权面板一个消费方，但 ① ui-commands 先例在前；② 服务形态由模块单实例约束强制，不是提前抽象；③ 已确认的后续场景（跨会话总览、常驻策略/封禁落地）都是面板候选。若第三个面板出现时注册 API 需要泛化，届时改接口比届时拆包便宜。

### 9. 命令式 open：面板缝的第二条打开路径（2026-08-28 补记，票 03）

`opsPanels` 服务新增 `open(sessionId, command)` / `close(sessionId)`：打开面板不再只有「人敲斜杠命令 → command/executed」一条路。第一个消费方是**待决申请角标**：agent 的 request_access 挂起时，输入区 dock 亮红点计数——从会话快照的 `runningCalls` 派生（tool/call 无配对 tool/result 即在飞），零服务端改动、零轮询，符合 model-visible⟺logged——点击经 `open` 拉起授权面板到审批台；全部裁决/超时后 runningCalls 清空，角标自灭。

**否决了「agent 申请即直接弹框」**：弹框打断人当前的阅读与输入，且叠加 5 分钟待决超时的场景里「打断」恰恰是最不需要自动做的事——人看到红点一键就到审批台。角标把打断权留给人，红点本身已是足够强的带外信号。

## 被否决方案汇总

| 方案 | 否决原因 |
|---|---|
| 固定 web 面板页（设置页/dock） | 要先枚举并选择目标会话，与 session 分键模型心智错位 |
| 面板机制做成纯库（ops-shell-tool 模式） | 消费方各自打包 = N 份注册表/监听/外壳互撞；必须是 DI 服务 |
| 复用 ui-commands popupSelect 外壳 | 严格单层契约，装不下"选档案→选 TTL"两步 |
| 档案 × TTL 拍平成 3N 行 | 丑且随档案数膨胀 |
| hack `popupFor()` 手动开第二层 | 未公开内部层；settle 路径破坏 token 消费 |
| 保留原生 approval + 自定义 answerer | 结果四态封闭无法改参数；waterfall 兄弟顺序无优先级，与内置 web answerer 抢单 |
| 撤销即掐断进行中命令 | 动命令生命周期，另一个量级；broker 现问语义已足够 |
| 常驻策略（信任环境长期放行） | 绕开"人一次性批准"原则，需独立威胁模型讨论——缓议 |
| 封禁（连 ro 都锁） | broker 需新增第四态，等面板落地后看真需求——缓议 |
| 跨会话总览与撤销 | 面板是会话作用域 UI，硬塞跨会话列表语义混乱——缓议 |

## 后果

- 实现触及三个包：**ops-panel**（新建：面板缝——client 的 `opsPanels` 注册服务 + overlay 外壳 + `command/executed` 分发，node 的 `registerPanelCommand` helper）、**gate**（待决队列、人侧 HTTP 路由、对称通知注入、新增 Config：TTL 档位/待决超时；`/access` 命令经 ops-panel 的 helper 注册）、**ops-access-ui**（降为纯消费方：client 半 `inject: ['opsPanels']` 注册授权面板内容组件 + 待决请求轮询）。
- 审计事件新增 `grant-request`（申请）与面板来源的 grant/revoke/超时决定行；`approvedBy` 区分面板与申请批准。
- headless 部署行为等价（快速失败），审计覆盖变好。
- 原生 approval 通道的 ApprovalPolicy 上下文（"ask/never"）不再约束 request_access——我们的通道没有 policy 概念，人不在就超时拒。
- 已知接受的风险不变（威胁模型仍是"防犯傻"）：面板和路由都在同进程，不防作恶。
