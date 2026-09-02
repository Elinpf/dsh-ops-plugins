# @elinpf/dsh-ops-prompts

Ops prompt orchestration center for DeepSeek Harness — one channel through which other ops plugins register methodology sections (static system-prompt text) and dynamic reminders (pre-step checks that inject ephemeral prompts).

## What it does

- **`ctx.get('opsPrompts')` handle** with two registration surfaces, each returning a disposer:
  - `registerMethodology({ name, order, text })` — a static system-prompt section. All entries are rendered by a single `ops:methodology` section (order-sorted) that is re-evaluated at every prompt assembly, so late registrations and disposals take effect without rebuilding the prompt.
  - `registerReminder({ name, check })` — a rule evaluated at each `agent/pre-step`. Non-null results are joined and delivered through `agent.inject`, which goes through the durable inbox splice: the reminder is reconstructable from the session log (model-visible ⟺ logged).
- **Core ops methodology** (`ops:core`, order 250): root-cause discipline, verify-before-concluding, and investigation structuring — the shared baseline every ops tool builds on.
- **Bundled skills provider** (`ops-prompts-bundled`, `src/skills.ts`): ships this package's `skills/` directory into dsh's native skill subsystem. Markdown files with native frontmatter (`name`/`description` required, `whenToUse` optional, `disable-model-invocation` honored) become catalog candidates; bodies are pulled on demand through the `skill` tool. The skills registry is optional — resolved get-first with an `ctx.inject` fallback, and tolerated when absent (the package then works as a pure prompt channel).

## Design notes

- **One section, many entries.** Methodology text aggregates into a single system-prompt section instead of one section per contributor, so ordering stays explicit (`order`) and prompt assembly reads one closure over the registry map.
- **Reminders are ephemeral, never durable state.** Rules live in fiber-local maps; only the injected message touches the session log, via the platform's own inbox splice — so this package owns no session event types and no projection.
- **Everything is fiber-scoped.** The system-prompt section and the skills provider register through `ctx.effect`; the pre-step listener is fiber-scoped via `ctx.on`. Fiber disposal/HMR removes every surface (covered by `tests/hmr-unload.spec.ts`).
- **A prompt-only skill is a text file, never a package** — the bundled provider exists so repo-managed Markdown skills ride the native catalog instead of a self-built loader.

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `reminderEnabled` | `boolean` | `true` | Whether dynamic reminders are evaluated at each agent/pre-step. |

Required inject: `systemPrompt`. Optional: `skills` (host-plane registry).

## Testing

```sh
npm run build   # tsc → lib/
npx vitest run  # unit specs + HMR unload spec
```

`tests/ops-prompts.spec.ts` covers the handle, methodology aggregation, and reminder delivery; `tests/skills.spec.ts` covers frontmatter parsing, the bundled provider, and the optional skills registration; `tests/hmr-unload.spec.ts` runs every collected disposer and asserts each registration surface is gone.
