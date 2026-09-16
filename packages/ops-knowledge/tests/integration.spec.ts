/**
 * Integration spec: the three knowledge tools against a real in-process hub
 * server (ephemeral port, tmp data-dir) — the record → search → hit → update
 * chain, error surfacing when the hub is down, and the session-start index
 * reminder fed from the live hub.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubStore, createHubServer } from '@elinpf/dsh-ops-access-hub'
import { mktmpdir } from '@elinpf/dsh-ops-test-support/tmpdir'
import { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import type { KnowledgeToolResult } from '../src/types.ts'

// The runtime validates tool output with additionalProperties:false — a
// result carrying an undeclared key (e.g. createdAt from a blind spread of
// the wire record) dies with ToolOutputError at dispatch. Pin every result
// through the same validator dsh-tools uses.
const outputSchema = valueSchemaSpecToJsonSchema(plugin.outputSchemaSpec as never)
function assertValidOutput(r: KnowledgeToolResult): void {
  validateJsonSchemaValue(outputSchema, r as never)
}

const READ = 'test-read-token'

let server: Server
let base: string
let tools: any[]
let reminders: Map<string, { check: (agent: unknown) => string | null }>
let effectCleanups: Array<() => void>

function tool(name: string): any {
  const t = tools.find((t) => t.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

async function run(name: string, args: Record<string, unknown>): Promise<KnowledgeToolResult> {
  const result: KnowledgeToolResult = await tool(name).execute(args)
  assertValidOutput(result)
  return result
}

beforeEach(async () => {
  const store = new HubStore({ dataDir: mktmpdir('knowledge-it-') })
  await store.init()
  server = createHubServer({ store, adminToken: 'admin', readToken: READ })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tools = []
  reminders = new Map()
  effectCleanups = []
  const effect = (fn: () => (() => void) | void): void => {
    const d = fn()
    if (d) effectCleanups.push(d)
  }
  const ctx: any = {
    effect,
    logger: () => ({ info: () => {}, warn: () => {} }),
    tools: {
      register: (t: any) => {
        tools.push(t)
        return () => { tools.splice(tools.indexOf(t), 1) }
      },
    },
    get: () => ({
      registerMethodology: () => () => {},
      registerReminder: (r: { name: string, check: (a: unknown) => string | null }) => {
        reminders.set(r.name, r)
        return () => { reminders.delete(r.name) }
      },
    }),
    inject: () => {},
  }
  plugin.apply(ctx, { hubUrl: base, hubToken: READ })
})

afterEach(async () => {
  for (const cleanup of effectCleanups) cleanup()
  await new Promise((r) => server.close(r))
})

const CASE = {
  title: 'CSI 卡住因为 Ceph 满',
  symptoms: ['pvc pending', 'csi operation stuck'],
  root_cause: 'Ceph 存储 99% 满, 阻塞 OMAP 写入',
  fix: '扩容 osd 并重启 csi 插件',
  methodology: 'ceph df 看到 99%; osd 日志有 OMAP slow, 排除网络方向',
  difficulty: 3,
  tags: ['ceph', 'csi'],
}

describe('record → search → hit → update', () => {
  it('runs the full chain through the tools', async () => {
    const recorded = await run('knowledge_record', CASE)
    expect(recorded.error).toBeUndefined()
    const id = recorded.id!

    const found = await run('knowledge_search', { query: 'csi stuck' })
    expect(found.error).toBeUndefined()
    expect(found.matches).toHaveLength(1)
    expect(found.matches![0]).toMatchObject({
      id, title: CASE.title, rootCause: CASE.root_cause,
      methodology: CASE.methodology, difficulty: 3, hitCount: 0,
    })

    const hit = await run('knowledge_hit', { id })
    expect(hit.error).toBeUndefined()
    const afterHit = await run('knowledge_search', { query: 'ceph' })
    expect(afterHit.matches![0].hitCount).toBe(1)

    const updated = await run('knowledge_record', { ...CASE, id, fix: '先清理快照再扩容' })
    expect(updated.error).toBeUndefined()
    const afterUpdate = await run('knowledge_search', { query: 'csi' })
    expect(afterUpdate.matches![0].fix).toBe('先清理快照再扩容')
    expect(afterUpdate.matches![0].hitCount).toBe(1) // hit count survives the update
  })

  it('search ranks by relevance and returns nothing on no match', async () => {
    await run('knowledge_record', CASE)
    await run('knowledge_record', {
      title: 'NTP 偏移导致证书校验失败',
      symptoms: ['x509 certificate not valid yet'],
      root_cause: '节点时钟偏移 5 分钟',
      fix: 'chrony 对时',
      tags: ['ntp'],
    })
    expect((await run('knowledge_search', { query: 'pvc' })).matches).toHaveLength(1)
    expect((await run('knowledge_search', { query: 'disk pressure' })).matches).toHaveLength(0)
  })

  it('query "*" browses all cases ranked by hits, whatever the keywords', async () => {
    await run('knowledge_record', CASE)
    await run('knowledge_record', {
      title: 'DNS 解析失败', symptoms: ['no such host'], root_cause: 'coredns 崩溃', fix: '重启 coredns',
    })
    const all = await run('knowledge_search', { query: '*', limit: 20 })
    expect(all.matches).toHaveLength(2)
    expect(all.matches!.map((m) => m.score)).toEqual([0, 0])
  })

  it('record without required fields surfaces the hub 400 as an error result', async () => {
    const r = await run('knowledge_record', { title: 'x', symptoms: [], root_cause: '', fix: '' })
    expect(r.error).toMatch(/required|non-empty/)
  })

  it('hit on an unknown id surfaces an error result, not a throw', async () => {
    const r = await run('knowledge_hit', { id: 'nope' })
    expect(r.error).toBeTruthy()
  })
})

describe('session-start index reminder', () => {
  it('injects the index once per session, ranked by hits', async () => {
    const a = await run('knowledge_record', CASE)
    const b = await run('knowledge_record', {
      title: 'DNS 解析失败', symptoms: ['no such host'], root_cause: 'coredns 崩溃', fix: '重启 coredns',
    })
    await run('knowledge_hit', { id: b.id! })
    expect(a.id).toBeTruthy()

    // Let the post-mutation index refresh land.
    await new Promise((r) => setTimeout(r, 100))

    const check = reminders.get('knowledge:index')!.check
    const text = check({ session: { id: 's1' } })
    expect(text).toContain('2 条历史病例')
    expect(text!.indexOf('DNS 解析失败')).toBeLessThan(text!.indexOf('CSI 卡住')) // hit case first
    expect(check({ session: { id: 's1' } })).toBeNull() // once per session
    expect(check({ session: { id: 's2' } })).not.toBeNull() // new session gets it again
  })
})

describe('hub down', () => {
  it('tools return error results instead of throwing', async () => {
    await new Promise((r) => server.close(r))
    const r = await run('knowledge_search', { query: 'x' })
    expect(r.error).toMatch(/unreachable/)
    // Re-bind a dummy server so afterEach close() does not throw.
    server = createHubServer({ store: new HubStore({ dataDir: mktmpdir('knowledge-it-') }), adminToken: 'a', readToken: 'r' })
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  })
})
