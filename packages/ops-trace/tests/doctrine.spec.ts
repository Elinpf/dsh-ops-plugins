/**
 * Doctrine tests: the canonical sentences live once in src/doctrine.ts and
 * every prompt surface composes from them. These tests pin that the surfaces
 * actually carry the canonical wording, so a hand-edit reintroducing a
 * divergent phrasing fails here instead of drifting silently.
 */

import { describe, it, expect } from 'vitest'
import {
  HELP_POINTER,
  HELP_TEXT,
  HYPOTHESIS_FORM,
  STATIC_PROMPT,
  TOOL_DESCRIPTION,
  TRIGGER_NODE_QUESTION,
  TRIGGER_NODE_RULE,
  TREE_ONE_LINER,
} from '../src/doctrine.ts'

describe('doctrine surfaces', () => {
  it('every surface points at the help action', () => {
    expect(TOOL_DESCRIPTION).toContain(HELP_POINTER)
    expect(STATIC_PROMPT).toContain(HELP_POINTER)
  })

  it('tool description and system prompt carry the canonical sentences', () => {
    expect(TOOL_DESCRIPTION).toContain(TREE_ONE_LINER)
    expect(STATIC_PROMPT).toContain(HYPOTHESIS_FORM)
    expect(STATIC_PROMPT).toContain(TRIGGER_NODE_RULE)
  })

  it('help text quotes the canonical trigger-node question and hypothesis form', () => {
    expect(HELP_TEXT).toContain(`"${TRIGGER_NODE_QUESTION}"`)
    expect(HELP_TEXT).toContain(HYPOTHESIS_FORM)
    expect(HELP_TEXT).toContain('### 触发节点 — parent_id 的唯一规则')
  })

  it('the trigger-node rule is the question plus the mapping, once', () => {
    expect(TRIGGER_NODE_RULE).toContain(TRIGGER_NODE_QUESTION)
    // The question must not appear twice in any single surface.
    expect(STATIC_PROMPT.split(TRIGGER_NODE_QUESTION)).toHaveLength(2)
    expect(HELP_TEXT.split(TRIGGER_NODE_QUESTION)).toHaveLength(2)
  })
})
