/**
 * The trace doctrine — one home per sentence.
 *
 * The same handful of ideas (what the tree is, the trigger-node rule, the
 * hypothesis form, where the full doc lives) used to be re-phrased in every
 * prompt surface: the tool description, the parameter descriptions, the
 * system-prompt core, the help text, and the reminder messages. They drifted
 * in wording if not in content. Now each canonical sentence lives here once
 * and the surfaces compose from it — same words everywhere, so the model
 * gets one consistent vocabulary to anchor on.
 *
 * Surfaces deliberately keep their own granularity: the tool description is
 * a one-liner, the system prompt carries the minimal core, and HELP_TEXT is
 * the full reference. Progressive disclosure is the point; duplication is not.
 *
 * @module @deepseek-ai/dsh-ops-tool-trace/doctrine
 */

// ── Canonical sentences ──────────────────────────────────────────────────────

/** What the tree is, in one line. */
export const TREE_ONE_LINER =
  '维护事件排查的调查树: goal → milestone(待验证假设) → step(验证动作)'

/** The question behind every parent_id decision. Also quoted verbatim by the
 *  nesting reminder. */
export const TRIGGER_NODE_QUESTION = '我为什么现在要做这个动作?'

/** The trigger-node mapping: where a new node hangs, by what triggered it. */
export const TRIGGER_NODE_MAPPING =
  '跟进某 step 的发现 → 挂那个 step; 验证某假设 → 挂该 milestone; 顶层假设 → "goal"'

/** The full trigger-node rule, one line (system-prompt core + parent_id
 *  parameter description). */
export const TRIGGER_NODE_RULE =
  `parent_id 的唯一规则 — ${TRIGGER_NODE_QUESTION} ${TRIGGER_NODE_MAPPING}。`

/** A milestone must be writable in this form, or it is not a hypothesis. */
export const HYPOTHESIS_FORM = '"我怀疑 X, 因为看到了 Y"'

/** Where the full documentation lives. */
export const HELP_POINTER = '完整用法与纪律: 调 `trace` action=help。'

// ── Composed surfaces ────────────────────────────────────────────────────────

/** One-liner for the tool registry description. */
export const TOOL_DESCRIPTION =
  `${TREE_ONE_LINER}。每个节点的 parent_id 是它的触发节点——让你此刻想做这个动作的那个节点。${HELP_POINTER}`

/**
 * Minimal always-on core for the system prompt (registered through
 * ops-prompts as a methodology section). The full doc is progressively
 * disclosed through the `help` action; reminders deliver individual rules
 * just-in-time.
 */
export const STATIC_PROMPT = [
  '## trace — 调查树',
  `用 \`trace\` 维护事件排查的调查树: goal → milestone(假设, 创建时必须能写出${HYPOTHESIS_FORM}) → step(验证动作)。`,
  TRIGGER_NODE_RULE,
  HELP_POINTER,
].join('\n')

/**
 * Full usage documentation, progressively disclosed: the system prompt only
 * carries the minimal core plus a pointer; the model pulls this via
 * `trace` action=help when it needs the details.
 */
export const HELP_TEXT = [
  '## trace — 调查树完整用法',
  '',
  '用 `trace` 维护事件排查的调查树。树形 = 推理链。',
  '',
  '### Actions',
  '- create_tree(goal_title) — 开始新调查; 前一棵树作为历史保留。',
  '- add_milestone(id, parent_id, title, detail?) — 立假设; detail 写 because 分句。',
  '- add_step(id, parent_id, title, detail?) — 加验证动作; detail 写查证对象。',
  '- start / complete / abandon / reopen(id 或 ids) — 状态流转; complete 可带 summary。',
  '- resolve(summary) — 全案收口, 只调一次, 只作用于最终 goal。',
  '- link(id, caused_by) 或 links 数组 — 跨分支因果边。',
  '- view — 完整树; status_filter 可选。',
  '',
  '### 触发节点 — parent_id 的唯一规则',
  `add_step / add_milestone 前问: "${TRIGGER_NODE_QUESTION}"`,
  '- 答案是某个 step 的发现/异常输出 → parent 是那个 step (这就是下钻)',
  '- 答案是一个待验证的假设 → parent 是那个 milestone',
  '- 顶层 milestone → parent 是 "goal"',
  '标题只写动作本身; 推理关系全部由 parent 表达。',
  '',
  '### step 先行',
  '调查动作(bash/kubectl/查日志)执行前先 add_step(title = 要查什么), 拿到结果立即 complete 带 summary。',
  '',
  '### milestone = 可被证据判伪的假设',
  `创建时必须能写出 ${HYPOTHESIS_FORM}, Y 是已有证据:`,
  '- 写得出 → add_milestone, because 分句写进 detail, title 只写假设本身',
  '- 写不出 → 先取证, 把取证动作 add_step 到当前触发节点下',
  '"Ceph 存储满了, 因为 osd.1 使用率 99%" ← 合格; "存储""网络" ← 没有 because 分句, 不是假设。',
  '- 证实 → complete 带 summary; 证伪 → abandon',
  '',
  '### 下钻与收敛',
  'complete 一个 step 前检查它的发现: 是否还悬着一个未解释的 "为什么"?',
  '- 有 → 在该 step 下 add_step 追问, 收敛发生在追问之后',
  '- 没有(已到物理/基础设施层事实: 磁盘满、内存耗尽、网络分区…) → 这一步收敛',
  '没有新报错指引方向时, 回到最近一个还悬着 "为什么" 的节点继续。',
  '',
  '### 其他',
  '- 死路 abandon, 保留在树上; 迷失方向先 view; 每 5 步排查至少更新 1 次 trace。',
  '- link 只表达 parent 无法表达的因果边(跨分支); 父子关系已隐含触发链, 不重复 link。',
  '- 新调查 create_tree; resolve 只调一次: 全案收口, 标记最终目标达成。假设的证实/证伪走 complete/abandon, 不用 resolve。',
].join('\n')
