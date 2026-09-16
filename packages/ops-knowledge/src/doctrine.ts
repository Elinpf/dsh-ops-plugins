/**
 * The knowledge doctrine — one home per sentence, same discipline as
 * ops-tool-trace's doctrine.ts: surfaces compose from these canonical
 * sentences instead of re-phrasing them.
 *
 * @module @elinpf/dsh-ops-knowledge/doctrine
 */

/** What the knowledge base is, in one line. */
export const KB_ONE_LINER = '排错知识库: 历史排查沉淀的病例 (症状 → 根因 → 修复), 存在 access hub 里跨会话共享'

/** The search-first rule, quoted by the methodology section and tool descriptions. */
export const SEARCH_FIRST_RULE = '动手排查前先 knowledge_search 查历史病例——命中的病例直接给根因和修复, 不用从头排查'

/** The record-on-resolve rule. */
export const RECORD_RULE =
  '全案收口 (trace resolve) 后, 若根因+修复有可复用价值: 先 knowledge_search 查重, 再 knowledge_record 沉淀——有近似旧病例就带 id 更新它, 没有才新建'

/** The case quality bar: the three questions a reusable case answers. */
export const QUALITY_BAR =
  '病例要回答三个问题: symptoms 让搜得到 (每条 = 症状类关键词 + 当时观察到的具体值, 如 "少盘: lsblk 应 7 块只识别 6 块"——类词让跨域同类问题也能命中, 具体值锚定报错原文/指标值), root_cause+fix 让直接用 (根因到物理层, 修复可执行), methodology 让相似场景复用方法 (哪一步判别了假设、哪条命令是关键)。排查的中间过程属于 trace 树, 知识库只存结晶'

/** Difficulty anchor text, shared by the methodology section and the tool parameter description. */
export const DIFFICULTY_ANCHORS =
  'difficulty 是排查难度自评 1-5: 1=看一眼就知道; 2=常规路径一小时内; 3=多轮假设验证; 4=跨组件深挖; 5=罕见/复现困难, 一天以上或多人会诊。难度越高越值得写 methodology'

/** The hit feedback rule. */
export const HIT_RULE = '采用了某病例的结论 → knowledge_hit 记一次采用; 越有用的病例在索引里浮得越高'

/** One-liner descriptions for the three tools. */
export const SEARCH_TOOL_DESCRIPTION = `搜排错知识库的历史病例 (症状 → 根因 → 修复)。${SEARCH_FIRST_RULE}。query 传 "*" 列出全部病例。`
export const RECORD_TOOL_DESCRIPTION = `沉淀一条排错病例到知识库。${RECORD_RULE}。`
export const HIT_TOOL_DESCRIPTION = '标记某条历史病例被本次排查采用 (hit_count++, 让有用的病例在索引里浮得更高)。'

/**
 * Minimal always-on core for the system prompt (registered through
 * ops-prompts as a methodology section).
 */
export const STATIC_PROMPT = [
  '## knowledge — 排错知识库',
  KB_ONE_LINER + '。',
  `- ${SEARCH_FIRST_RULE}。`,
  `- ${RECORD_RULE}。`,
  `- ${QUALITY_BAR}。`,
  `- 难度自评 difficulty 1-5; 难度 ≥3 的病例一定要写 methodology (怎么查出来的), 那才是最难复得的部分。`,
  `- ${HIT_RULE}。`,
].join('\n')

/**
 * The session-start index reminder body. Rendered from the cached index,
 * fired once per session at the first pre-step.
 */
export function indexReminderText(rows: Array<{ id: string, title: string, symptoms: string[], hitCount: number }>): string {
  const lines = rows.map((r) => `- ${r.title} — 症状: ${r.symptoms.join('; ') || '(未记录)'} [采用 ${r.hitCount} 次]`)
  return [
    `## 排错知识库 — ${rows.length} 条历史病例 (按采用次数排序, knowledge_search 查全文)`,
    ...lines,
  ].join('\n')
}
