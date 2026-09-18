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
    for (const call of ["'/tokens'", "'/whoami'", "'/tokens/' + encodeURIComponent(p[0])"]) {
      expect(script).toContain(call)
    }
    // The audit table renders the actor attribution column.
    expect(script).toContain("esc(a.actor || '—')")
  })

  it('keeps the UI free of the template-literal syntax that would break the HTML string', () => {
    // The module builds the page with a template literal: an embedded backtick
    // or ${ would terminate it and corrupt the served HTML.
    const body = inlineScript()
    expect(body).not.toContain('`')
    expect(body).not.toContain('${')
  })
})
