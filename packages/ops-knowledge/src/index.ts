/**
 * Ops-knowledge: a troubleshooting knowledge base backed by the access hub.
 *
 * Three model-facing tools — `knowledge_search` (search past postmortem
 * cases before diagnosing), `knowledge_record` (distill a resolved
 * investigation into a case), `knowledge_hit` (mark a case as useful, so the
 * valuable ones float). A session-start reminder injects the case index
 * (title + symptoms, ranked by hits) through ops-prompts, so later sessions
 * see prior conclusions without being asked.
 *
 * The hub holds the durable data; this plugin is a thin, stateless client
 * plus prompt wiring. When no hub is configured the plugin no-ops; when the
 * hub is unreachable the tools return an error result — knowledge problems
 * must never break a session.
 *
 * @module @elinpf/dsh-ops-knowledge
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { OpsPromptsHandle } from '@elinpf/dsh-ops-prompts'
import { KnowledgeClient } from './client.js'
import { DIFFICULTY_ANCHORS, HIT_TOOL_DESCRIPTION, RECORD_TOOL_DESCRIPTION, SEARCH_TOOL_DESCRIPTION, STATIC_PROMPT, indexReminderText } from './doctrine.js'
import { rankCases } from './search.js'
import type { CaseIndexRow, CaseInput, CaseMatch, KnowledgeToolResult } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    opsPrompts?: OpsPromptsHandle
  }
}

// ── Plugin identity ───────────────────────────────────────────────────────────

const name = 'ops-knowledge'
const inject = ['tools']

// ── Config ───────────────────────────────────────────────────────────────────

interface Config {
  /** Hub base URL, e.g. http://127.0.0.1:3090. Falls back to env ACCESS_HUB_URL. */
  hubUrl?: string
  /** Hub token (read role is enough — /cases accepts read+ writes). Falls back to env ACCESS_HUB_READ_TOKEN. */
  hubToken?: string
}

const Config = z.object({
  hubUrl: z.string(),
  hubToken: z.string(),
})

// ── Shared output schema ─────────────────────────────────────────────────────

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    symptoms: { type: 'array', items: { type: 'string' }, required: true },
    rootCause: { type: 'string', required: true },
    fix: { type: 'string', required: true },
    evidence: { type: 'string' },
    methodology: { type: 'string' },
    difficulty: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    environment: { type: 'string' },
    hitCount: { type: 'integer', required: true },
    score: { type: 'number', required: true },
    updatedAt: { type: 'string', required: true },
  },
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    note: { type: 'string' },
    error: { type: 'string' },
    id: { type: 'string' },
    matches: { type: 'array', items: MATCH_SCHEMA },
  },
} as const

// Exported for tests: lets a spec validate results through dsh-tools' real
// schema validator (the runtime rejects undeclared keys on tool output).
export const outputSchemaSpec = OUTPUT_SCHEMA

function renderResult(value: KnowledgeToolResult): string {
  if (value.error) return `knowledge ${value.action} 失败: ${value.error}`
  if (value.matches) {
    if (value.matches.length === 0) return '没有命中的历史病例。'
    return value.matches
      .map((m, i) => [
        `### ${i + 1}. ${m.title}  [相关度 ${m.score} · 采用 ${m.hitCount} 次${m.difficulty !== undefined ? ` · 难度 ${m.difficulty}/5` : ''} · id: ${m.id}]`,
        `症状: ${m.symptoms.join('; ')}`,
        `根因: ${m.rootCause}`,
        `修复: ${m.fix}`,
        ...(m.methodology ? [`方法论: ${m.methodology}`] : []),
        ...(m.evidence ? [`证据: ${m.evidence}`] : []),
      ].join('\n'))
      .join('\n\n')
  }
  return value.note ?? 'ok'
}

const render = (_args: unknown, value: KnowledgeToolResult) => [{ type: 'text' as const, text: renderResult(value) }]

// ── Plugin body ──────────────────────────────────────────────────────────────

function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('ops-knowledge')
  const hubUrl = (config.hubUrl || process.env.ACCESS_HUB_URL || '').replace(/\/+$/, '')
  const hubToken = config.hubToken || process.env.ACCESS_HUB_READ_TOKEN || ''
  if (hubUrl === '' || hubToken === '') {
    logger.info('no hub configured (hubUrl/hubToken or ACCESS_HUB_URL/ACCESS_HUB_READ_TOKEN) — knowledge base disabled')
    return
  }
  const client = new KnowledgeClient({ baseUrl: hubUrl, token: hubToken })

  // The case index cache feeds the session-start reminder (whose check is
  // synchronous). Refreshed at boot and after every successful mutation;
  // failures keep the stale cache — a reminder with old data beats none.
  let indexCache: CaseIndexRow[] = []
  const refreshIndex = (): void => {
    client.listCases().then((rows) => { indexCache = rows }).catch((err) => {
      logger.warn('case index refresh failed: %s', (err as Error).message)
    })
  }
  refreshIndex()

  // Sessions that already received the index reminder (fire once per session).
  const remindedSessions = new Set<string>()
  ctx.effect(() => () => { remindedSessions.clear(); indexCache = [] })

  const fail = (action: KnowledgeToolResult['action'], err: unknown): KnowledgeToolResult => ({
    action,
    error: (err as Error).message,
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: SEARCH_TOOL_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: '症状/组件关键字, 如 "csi stuck ceph" 或报错原文片段。传 "*" 列出全部病例 (按采用次数排序)。' },
      limit: { type: 'integer', description: '最多返回几条 (默认 5)。' },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args: { query: string, limit?: number }): Promise<KnowledgeToolResult> {
      try {
        const index = await client.listCases()
        indexCache = index
        // "*" lists everything (browse intent), ranked by adoption count.
        const ranked = args.query.trim() === '*'
          ? [...index].sort((a, b) => b.hitCount - a.hitCount).map((row) => ({ row, score: 0 }))
          : rankCases(index, args.query)
        const matches: CaseMatch[] = []
        for (const { row, score } of ranked.slice(0, args.limit ?? 5)) {
          const full = await client.getCase(row.id)
          // Build the match field-by-field: the runtime validates tool output
          // against OUTPUT_SCHEMA with additionalProperties:false, so a blind
          // spread of the wire record (createdAt!) would fail validation.
          matches.push({
            id: full.id,
            title: full.title,
            symptoms: full.symptoms,
            rootCause: full.rootCause,
            fix: full.fix,
            ...(full.evidence !== undefined ? { evidence: full.evidence } : {}),
            ...(full.methodology !== undefined ? { methodology: full.methodology } : {}),
            ...(full.difficulty !== undefined ? { difficulty: full.difficulty } : {}),
            tags: full.tags,
            ...(full.environment !== undefined ? { environment: full.environment } : {}),
            hitCount: full.hitCount,
            score,
            updatedAt: full.updatedAt,
          })
        }
        return { action: 'search', matches }
      } catch (err) {
        return fail('search', err)
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'knowledge_record',
    description: RECORD_TOOL_DESCRIPTION,
    parameters: {
      id: { type: 'string', description: '已有病例的 id — 带上它 = 更新那条 (查重后发现近似旧病例时用); 不带 = 新建。' },
      title: { type: 'string', required: true, description: '一句话概括, 如 "CSI 卡住因为 Ceph 存储满"。' },
      symptoms: { type: 'array', items: { type: 'string' }, required: true, description: '当时观察到的具体现象: 报错原文片段、指标值、命令输出特征。是搜索的入口, 写具体。' },
      root_cause: { type: 'string', required: true, description: '根因, 到物理/基础设施层 (不是中间现象)。' },
      fix: { type: 'string', required: true, description: '可执行的修复动作。' },
      evidence: { type: 'string', description: '关键证据 (日志行、命令输出)。' },
      methodology: { type: 'string', description: '方法论: 当时怎么从症状定位到根因的——关键的判别步骤/命令 (哪一步区分了两个假设、哪个证据判伪了错误方向)。给"症状不同但问题同类"的未来排查复用。' },
      difficulty: { type: 'integer', description: DIFFICULTY_ANCHORS + '。' },
      tags: { type: 'array', items: { type: 'string' }, description: '组件/领域标签, 如 ["ceph", "csi"]。' },
      environment: { type: 'string', description: '适用环境, 如 "prod k8s 集群"。' },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args: {
      id?: string, title: string, symptoms: string[], root_cause: string, fix: string,
      evidence?: string, methodology?: string, difficulty?: number, tags?: string[], environment?: string
    }): Promise<KnowledgeToolResult> {
      const input: CaseInput = {
        title: args.title,
        symptoms: args.symptoms,
        rootCause: args.root_cause,
        fix: args.fix,
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
        ...(args.methodology !== undefined ? { methodology: args.methodology } : {}),
        ...(args.difficulty !== undefined ? { difficulty: args.difficulty } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.environment !== undefined ? { environment: args.environment } : {}),
      }
      try {
        const id = await client.putCase(input, args.id)
        refreshIndex()
        return { action: 'record', id, note: args.id ? `病例 ${id} 已更新。` : `病例已沉淀, id: ${id}。` }
      } catch (err) {
        return fail('record', err)
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'knowledge_hit',
    description: HIT_TOOL_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: '病例 id (knowledge_search 结果里有)。' },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args: { id: string }): Promise<KnowledgeToolResult> {
      try {
        await client.hit(args.id)
        refreshIndex()
        return { action: 'hit', id: args.id, note: `已记录对病例 ${args.id} 的采用。` }
      } catch (err) {
        return fail('hit', err)
      }
    },
  })))

  // ── Prompt wiring (through ops-prompts) ────────────────────────────────────
  // Same dual-mode resolution as ops-tool-trace: a one-shot ctx.get can lose
  // the race against ops-prompts' provide, so fall back to ctx.inject.
  const registerThroughHandle = (rctx: Context, opsPrompts: OpsPromptsHandle): void => {
    rctx.effect(() => {
      const disposeMethodology = opsPrompts.registerMethodology({
        name: 'knowledge:usage',
        order: 250,
        text: STATIC_PROMPT,
      })
      const disposeIndex = opsPrompts.registerReminder({
        name: 'knowledge:index',
        check: (agent: unknown): string | null => {
          const sessionId = (agent as { session?: { id?: string } })?.session?.id
          if (!sessionId || remindedSessions.has(sessionId)) return null
          if (indexCache.length === 0) return null
          remindedSessions.add(sessionId)
          const top = [...indexCache].sort((a, b) => b.hitCount - a.hitCount).slice(0, 10)
          return indexReminderText(top)
        },
      })
      return () => { disposeMethodology(); disposeIndex() }
    })
  }

  const immediateOpsPrompts = ctx.get('opsPrompts')
  if (immediateOpsPrompts !== undefined) {
    registerThroughHandle(ctx, immediateOpsPrompts)
  } else {
    ctx.inject(['opsPrompts'], (pctx: Context) => {
      registerThroughHandle(pctx, pctx.opsPrompts!)
    })
  }
}

export { Config, apply, inject, name }
export * from './types.js'
export { rankCases, queryTokens, scoreRow } from './search.js'
export { KnowledgeClient } from './client.js'
