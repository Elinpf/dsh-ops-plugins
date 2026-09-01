# @deepseek-ai/dsh-ops-trace-ui

The host-plane half of the ops trace feature — registers the shared `trace` session projection and ships the web panel client bundle (the investigation-tree panel above the composer).

## What it does

One thin shell, two halves:

- **Host half** (`src/index.ts`): registers the shared `trace` projection into `ctx.sessionProjections`, deferred through `ctx.inject` so the loader never orders this row against the registry. The projection definition is imported **verbatim** from `@deepseek-ai/dsh-ops-tool-trace` — reference identity, not a copy — so key/schema/fold/stateVersion can never drift between the tool half and the panel half.
- **Client half** (`src/client.ts`, esbuild-bundled to `lib/client.js`): registers a `conversation.input.dock` entry (`id: 'ops-tree'`) that renders a collapsible investigation-tree panel, structurally identical to todo_write's TodoPanel. Reads the `trace` projection via `useProjection`; degrades to rendering nothing when the registry is absent.

Registers no tools and no prompt sections — the `trace` tool and its methodology live in `@deepseek-ai/dsh-ops-tool-trace`, mounted preset-plane.

## Design notes

- **Why a separate package**: the trace feature splits by plane. The tool is preset-plane (model-facing); the projection registry and web client carriers are host-plane. This package is the host-plane mount point — a row the ops preset composes so the panel reaches the browser.
- **Client discovery is runtime**: the web app's ClientModuleRegistry scans the composed host cordis entries, so this package must stay mounted host-plane via its `cordis.patch.yml` row or the panel never reaches the browser.
- **Shared layout**: sibling ordering, depth, and DFS flattening come from `ops-tool-trace/tree-layout` — the human sees the same layout the model sees.
- **Per-session UI state**: the dock unmounts on conversation switch, resetting React state; the collapse/selection choices live in a module-level map keyed by session (`DockUiState` in `./types`) so they survive unmount.

## Configuration

```yaml
- id: ops-trace-ui
  name: '@deepseek-ai/dsh-ops-trace-ui'
```

No config keys — `Config` is an empty schemastery object.

## Testing

```sh
npm run build   # tsc → lib/, then esbuild → lib/client.js
npx vitest run
```

Unit tests cover both entries' export shape (function-plugin form, no default export), the verbatim projection registration, the fold behavior driven through the registered definition, the dock slot registration, and HMR unload — running every fiber disposer removes both the projection and the dock entry.
