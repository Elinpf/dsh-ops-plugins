/**
 * Bundled skills provider spec: native frontmatter parsing, directory
 * listing, provider get/list behavior, the real bundled remediation skill,
 * and the apply-time optional registration against a fake skills registry.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import {
  BUNDLED_SKILLS_PROVIDER,
  bundledSkillsDir,
  createBundledSkillsProvider,
  listBundledSkills,
  parseSkillFrontmatter,
} from '../src/skills.ts'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ops-prompts-skills-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

describe('parseSkillFrontmatter', () => {
  it('parses name/description/whenToUse and disable-model-invocation', () => {
    const fm = parseSkillFrontmatter('---\nname: remediation\ndescription: 四阶段纪律\nwhenToUse: 需要 rw 修复时\ndisable-model-invocation: true\n---\nbody')
    expect(fm).toEqual({
      name: 'remediation',
      description: '四阶段纪律',
      whenToUse: '需要 rw 修复时',
      disableModelInvocation: true,
    })
  })

  it('requires name AND description (native rule)', () => {
    expect(parseSkillFrontmatter('---\nname: x\n---\nbody')).toBeNull()
    expect(parseSkillFrontmatter('---\ndescription: y\n---\nbody')).toBeNull()
    expect(parseSkillFrontmatter('没有 frontmatter')).toBeNull()
  })

  it('defaults: no whenToUse, model invocation enabled', () => {
    const fm = parseSkillFrontmatter('---\nname: x\ndescription: y\n---\nbody')!
    expect(fm.whenToUse).toBeUndefined()
    expect(fm.disableModelInvocation).toBe(false)
  })
})

describe('listBundledSkills', () => {
  it('lists valid .md files as bundled candidates, skips bad ones', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'good.md'), '---\nname: good\ndescription: 好 skill\nwhenToUse: 用得着时\n---\n正文')
    await writeFile(join(dir, 'bad.md'), '没有 frontmatter')
    await writeFile(join(dir, 'no-desc.md'), '---\nname: nodesc\n---\n正文')
    await writeFile(join(dir, 'notes.txt'), '---\nname: not-md\ndescription: x\n---\n正文')

    const { candidates, skipped } = await listBundledSkills(dir)
    expect(candidates).toHaveLength(1)
    const c = candidates[0]
    expect(c).toMatchObject({
      name: 'good',
      description: '好 skill',
      whenToUse: '用得着时',
      provider: BUNDLED_SKILLS_PROVIDER,
      source: 'bundled',
      path: join(dir, 'good.md'),
      locator: join(dir, 'good.md'),
    })
    expect(c.resourceBase).toEqual({ kind: 'directory', path: dir })
    expect(typeof c.rank).toBe('number')
    expect(c.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(skipped.sort()).toEqual([join(dir, 'bad.md'), join(dir, 'no-desc.md')].sort())
  })

  it('a missing directory yields nothing, never throws', async () => {
    const { candidates, skipped } = await listBundledSkills('/nonexistent/skills')
    expect(candidates).toEqual([])
    expect(skipped).toEqual([])
  })
})

describe('createBundledSkillsProvider', () => {
  it('list warns on skipped files; get returns the full body', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'good.md'), '---\nname: good\ndescription: 好 skill\n---\n\n正文内容\n')
    await writeFile(join(dir, 'bad.md'), 'broken')
    const warnings: string[] = []
    const provider = createBundledSkillsProvider(dir, m => warnings.push(m))

    expect(provider.name).toBe(BUNDLED_SKILLS_PROVIDER)
    const candidates = await provider.list({} as any)
    expect(candidates).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad.md')

    const definition = await provider.get(candidates[0], {} as any)
    expect(definition).toMatchObject({
      name: 'good',
      description: '好 skill',
      provider: BUNDLED_SKILLS_PROVIDER,
      source: 'bundled',
      content: '---\nname: good\ndescription: 好 skill\n---\n\n正文内容\n',
    })
  })
})

describe('the real bundled skills directory', () => {
  it('offers the remediation skill with routing description and whenToUse', async () => {
    const provider = createBundledSkillsProvider()
    const candidates = await provider.list({} as any)
    const remediation = candidates.find(c => c.name === 'remediation')
    expect(remediation).toBeDefined()
    expect(remediation!.description).toContain('rw 修复')
    expect(remediation!.description).toContain('spawn')
    expect(remediation!.whenToUse).toContain('rw')
    expect(remediation!.path).toBe(join(bundledSkillsDir(), 'remediation.md'))
    // 修复是重操作:人显式 /remediation 触发,模型 catalog 与 skill 工具都看不到它
    expect(remediation!.invocation).toEqual({ modelInvocable: false, userInvocable: true })

    const definition = await provider.get(remediation!, {} as any)
    for (const section of ['触发条件', '四阶段', '方案模板', '验证清单', 'spawn 纪律', 'rw 申请纪律', '失败模式']) {
      expect(definition.content).toContain(section)
    }
    for (const element of ['目标', '步骤', '预期结果', '回滚', '影响面']) {
      expect(definition.content).toContain(element)
    }
  })
})

describe('apply: optional skills registration', () => {
  function fakeCtx(skills?: any) {
    const effects: Array<() => void> = []
    const injected: Array<{ services: string[], fn: (pctx: any) => void }> = []
    const ctx: any = {
      provide: () => {},
      get: (key: string) => key === 'skills' ? skills : undefined,
      inject: (services: string[], fn: (pctx: any) => void) => { injected.push({ services, fn }) },
      effect: (fn: () => (() => void) | void) => { const d = fn(); if (d) effects.push(d) },
      on: () => {},
      logger: () => ({ warn: () => {} }),
    }
    plugin.apply(ctx, { reminderEnabled: false })
    return { ctx, effects, injected }
  }

  it('registers the bundled provider when the skills registry is present', () => {
    const factories: Array<() => any> = []
    const registry = { registerProvider: (factory: () => any) => { factories.push(factory); return () => {} } }
    const { effects, injected } = fakeCtx(registry)
    expect(factories).toHaveLength(1)
    expect(factories[0]().name).toBe(BUNDLED_SKILLS_PROVIDER)
    expect(effects).toHaveLength(1) // registration is an effect (HMR-safe)
    expect(injected).toHaveLength(0)
  })

  it('falls back to ctx.inject when the registry is not yet provided', () => {
    const factories: Array<() => any> = []
    const registry = { registerProvider: (factory: () => any) => { factories.push(factory); return () => {} } }
    const { injected } = fakeCtx(undefined)
    expect(injected).toHaveLength(1)
    expect(injected[0].services).toEqual(['skills'])
    injected[0].fn({ skills: registry, effect: (fn: () => any) => fn(), logger: () => ({ warn: () => {} }) })
    expect(factories).toHaveLength(1)
  })

  it('a missing skills service never breaks apply', () => {
    expect(() => fakeCtx(undefined)).not.toThrow()
  })
})
