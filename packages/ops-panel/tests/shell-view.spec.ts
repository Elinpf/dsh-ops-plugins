// @vitest-environment jsdom
/**
 * ShellView render spec (jsdom): the overlay frame hands session-scope
 * entries the framework session kit — sessionId as a DIRECT prop, no owner
 * props. This guards the 2026-08-27 regression where the shell waited for
 * a { session } owner prop (the input.dock shape) that
 * conversation.input.overlay never passes, so the panel never opened.
 */
import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createElement as h } from 'react'
import { createPanelCore, ShellView } from '../src/client.ts'

// React 18 act environment flag for jsdom.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function mount(core: ReturnType<typeof createPanelCore>, props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  // ShellView takes (props, core) — core is a closure arg, not a prop.
  act(() => {
    root.render(h((p: Record<string, unknown>) => ShellView(p, core) as never, props))
  })
  return { container, root }
}

describe('ShellView (overlay frame props)', () => {
  it('renders nothing without a sessionId prop', () => {
    const core = createPanelCore()
    core.registerPanel({ command: 'access', title: '访问授权', component: () => h('div', null, 'panel-body') })
    act(() => { core.open('sess-1', 'access') })
    const { container } = mount(core, {})
    expect(container.querySelector('.ops-panel-backdrop')).toBeNull()
  })

  it('opens the panel of THIS session when command/executed fires', () => {
    const core = createPanelCore()
    core.registerPanel({ command: 'access', title: '访问授权', component: () => h('div', null, 'panel-body') })
    const { container } = mount(core, { sessionId: 'sess-1' })
    expect(container.querySelector('.ops-panel-backdrop')).toBeNull()
    act(() => { core.handleCommandExecuted('sess-1', 'access') })
    expect(container.querySelector('.ops-panel-backdrop')).not.toBeNull()
    expect(container.textContent).toContain('访问授权')
    expect(container.textContent).toContain('panel-body')
  })

  it('ignores events of other sessions and unregistered commands', () => {
    const core = createPanelCore()
    core.registerPanel({ command: 'access', title: '访问授权', component: () => h('div', null, 'panel-body') })
    const { container } = mount(core, { sessionId: 'sess-1' })
    act(() => { core.handleCommandExecuted('sess-2', 'access') })
    act(() => { core.handleCommandExecuted('sess-1', 'plan') })
    expect(container.querySelector('.ops-panel-backdrop')).toBeNull()
  })

  it('closes on Escape and on the close button', () => {
    const core = createPanelCore()
    core.registerPanel({ command: 'access', title: '访问授权', component: () => h('div', null, 'panel-body') })
    const { container } = mount(core, { sessionId: 'sess-1' })
    act(() => { core.handleCommandExecuted('sess-1', 'access') })
    expect(container.querySelector('.ops-panel-backdrop')).not.toBeNull()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(container.querySelector('.ops-panel-backdrop')).toBeNull()
    act(() => { core.handleCommandExecuted('sess-1', 'access') })
    act(() => { (container.querySelector('.ops-panel-close') as HTMLButtonElement).click() })
    expect(container.querySelector('.ops-panel-backdrop')).toBeNull()
  })
})
