/**
 * Bundled ops skills provider.
 *
 * Ships the repo-managed ops skills (Markdown files in this package's
 * `skills/` directory) into dsh's NATIVE skill subsystem: candidates carry
 * name + description into the model-facing catalog, bodies are pulled on
 * demand through the `skill` tool. This replaces the earlier self-built
 * loader — the platform already owns discovery, ranking, and loading.
 *
 * Modeled on @deepseek-ai/dsh-skill-badge: provider candidates are listed
 * from the bundled directory, bodies are read from disk relative to this
 * module (same ../skills layout from src/ in tests and lib/ at runtime).
 *
 * @module @deepseek-ai/dsh-ops-prompts
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

export const BUNDLED_SKILLS_PROVIDER = 'ops-prompts-bundled'

const SKILLS_DIR_URL = new URL('../skills/', import.meta.url)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** The bundled skills directory (package root/skills, from src/ or lib/). */
export function bundledSkillsDir(): string {
  return fileURLToPath(SKILLS_DIR_URL)
}

export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation: boolean
}

/**
 * Parse a native skill file's frontmatter. `name` and `description` are
 * required — a file missing either is not a skill and returns null (the
 * caller skips it with a warning).
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) return null
  const fields = new Map<string, string>()
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(\S[\s\S]*)?$/)
    if (!kv) continue
    fields.set(kv[1], (kv[2] ?? '').trim())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (!name || !description) return null
  const parsed: SkillFrontmatter = {
    name,
    description,
    disableModelInvocation: fields.get('disable-model-invocation') === 'true',
  }
  const whenToUse = fields.get('whenToUse')
  if (whenToUse) parsed.whenToUse = whenToUse
  return parsed
}

export interface BundledListResult {
  candidates: SkillCandidate[]
  /** Files skipped for missing/invalid frontmatter (diagnostics). */
  skipped: string[]
}

/** List valid skill candidates from a directory of `.md` files. */
export async function listBundledSkills(dir: string = bundledSkillsDir()): Promise<BundledListResult> {
  const candidates: SkillCandidate[] = []
  const skipped: string[] = []
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return { candidates, skipped } // no bundled dir — nothing to offer
  }
  const resourceBase = { kind: 'directory', path: dir } as const
  for (const file of files.filter(f => f.endsWith('.md')).sort()) {
    const path = join(dir, file)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      skipped.push(path)
      continue
    }
    const fm = parseSkillFrontmatter(text)
    if (fm === null) {
      skipped.push(path)
      continue
    }
    const candidate: SkillCandidate = {
      name: fm.name,
      description: fm.description,
      ...fm.whenToUse !== undefined ? { whenToUse: fm.whenToUse } : {},
      invocation: { ...INVOCATION, modelInvocable: !fm.disableModelInvocation },
      provider: BUNDLED_SKILLS_PROVIDER,
      source: 'bundled',
      resourceBase,
      rank: BUNDLED_SKILL_RANK,
      locator: path,
      path,
    }
    candidates.push(candidate)
  }
  return { candidates, skipped }
}

/** Create the bundled provider over a skills directory (injectable for tests). */
export function createBundledSkillsProvider(
  dir: string = bundledSkillsDir(),
  warn: (message: string) => void = () => {},
): SkillProvider {
  return {
    name: BUNDLED_SKILLS_PROVIDER,
    async list() {
      const { candidates, skipped } = await listBundledSkills(dir)
      if (skipped.length > 0) {
        // Skips are authoring mistakes in this repo — surface loudly enough
        // to be fixed, without failing the whole catalog.
        warn(`ops-prompts bundled skills: skipped ${skipped.join(', ')} (frontmatter requires name and description)`)
      }
      return candidates
    },
    async get(candidate): Promise<SkillDefinition> {
      const path = candidate.locator as string
      return {
        name: candidate.name,
        description: candidate.description,
        ...candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {},
        invocation: candidate.invocation,
        provider: BUNDLED_SKILLS_PROVIDER,
        source: 'bundled',
        resourceBase: candidate.resourceBase,
        content: await readFile(path, 'utf8'),
        path,
      }
    },
  }
}
