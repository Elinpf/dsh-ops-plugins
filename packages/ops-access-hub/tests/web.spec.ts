/**
 * Guard for the single-file web shell. The inline script is a plain string
 * inside a template literal, so a typo (a stray brace, a quote mix-up) is
 * invisible to `tsc` and only breaks the page at runtime — here it is
 * compiled in-process instead.
 */

import { describe, expect, it } from 'vitest'
import { WEB_UI_HTML } from '../src/web.ts'

function inlineScript(): string {
  const match = /<script>([\s\S]*)<\/script>/.exec(WEB_UI_HTML)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('web UI shell', () => {
  it('ships an inline script that parses as JavaScript', () => {
    // Compiling the function body is a pure syntax check — the DOM code never runs.
    expect(() => new Function(inlineScript())).not.toThrow()
  })

  it('carries the token roster surface, the one-time issuance box and the audit actor column', () => {
    const script = inlineScript()
    for (const id of ['showTokens', 'newToken', 'tokens', 'issuedBox', 'issuedToken', 'createToken', 'cancelToken', 'copyIssued', 'whoami']) {
      expect(WEB_UI_HTML).toContain(`id="${id}"`)
    }
    // Endpoints the roster view drives.
    for (const call of ["'/tokens'", "'/whoami'", "'/tokens/' + encodeURIComponent(revokeId)"]) {
      expect(script).toContain(call)
    }
    // The audit table renders the actor attribution column.
    expect(script).toContain("esc(a.actor || '—')")
  })

  it('carries the fine-grained roster controls (status badges, filters, in-place edit)', () => {
    const script = inlineScript()
    for (const id of ['tokenFilter', 'tokenStatusFilter', 'tokenRoleFilter', 'tokenSummary', 'tokenEdit', 'eName', 'eRole', 'eExpires', 'eClearExpires', 'saveTokenEdit', 'cancelTokenEdit']) {
      expect(WEB_UI_HTML).toContain(`id="${id}"`)
    }
    // Every status the roster can badge, plus the four filter options.
    for (const status of ["'revoked'", "'expired'", "'expiring'", "'active'"]) {
      expect(script).toContain(status)
    }
    // The edit dialog patches in place and reports which fields it touched.
    expect(script).toContain("method: 'PATCH'")
    expect(script).toContain("'/tokens/' + encodeURIComponent(editingTokenId)")
    expect(script).toContain('data-edit-token')
    expect(script).toContain('r.body.changes')
  })

  it('keeps the UI free of the template-literal syntax that would break the HTML string', () => {
    // The module builds the page with a template literal: an embedded backtick
    // or ${ would terminate it and corrupt the served HTML.
    const body = inlineScript()
    expect(body).not.toContain('`')
    expect(body).not.toContain('${')
  })
})
