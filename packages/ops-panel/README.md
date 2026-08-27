# @deepseek-ai/dsh-ops-panel

The panel seam for DeepSeek Harness ops plugins — one shared mechanism for session-scoped overlay dialogs triggered by slash commands (ADR-0004).

## What it does

Business packages should not each invent their own dialog shell, keyboard handling, and command dispatch. ops-panel splits that concern in two:

- **Client half** (`ops-panel-client`): provides the `opsPanels` registry service. Consumers register one panel definition per command — `registerPanel({ command, title, component })`. The shell renders the open panel as a centered modal over a backdrop (Escape / backdrop click closes), injected into the `conversation.input.overlay` slot. A single `command/executed` listener dispatches to the right panel by command name, so N panels cost one listener, not N.
- **Host helper** (`registerPanelCommand(ctx, { name, description })`): registers the slash command itself — a no-op success handler whose only job is to exist in the session's command directory so the UI lets the user submit it and fires `command/executed`. Registers agent-scoped when called from the preset plane; fails loud when the `commands` service is absent.

A panel component receives `{ sessionId, close }` and owns everything inside the card — data fetching, polling, actions.

## Why a service, not a library

Bundling this code per consumer would give every consumer its own registry, its own `command/executed` listener, and its own overlay shell — and only the last-registered shell would win. As a cordis service there is exactly one registry and one shell per page, and panels can be registered from any plugin.

## Installation

Add to the app dependencies and reference in `cordis.patch.yml` (host plane):

```yaml
- id: ops-panel
  name: '@deepseek-ai/dsh-ops-panel'
```

Consumers register from their own client halves:

```ts
ctx.inject(['opsPanels'], (pctx) => {
  pctx.effect(() => pctx.opsPanels.registerPanel({
    command: 'access',
    title: '访问授权',
    component: AccessPanel,
  }))
})
```

…and register the command from their preset-plane host half:

```ts
ctx.inject(['commands'], (cctx) => {
  registerPanelCommand(cctx, { name: 'access', description: '打开授权面板' })
})
```

First consumer: the access panel (`ops-access-ui` + `ops-access/gate`, spec 0003).

## Known Limitations

- One open panel at a time (opening another replaces the current one).
- The shell is deliberately minimal (title + close) — tab bars, sizing, and drag belong to a later iteration if a second consumer needs them.
- `command/executed` fires only for sessions whose preset mounts the command — panels are inherently preset-scoped.
