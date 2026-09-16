# @elinpf/dsh-ops-knowledge

Troubleshooting knowledge base for DeepSeek Harness ops mode — distilled postmortem **cases** (`symptoms → root cause → fix`) stored centrally in the [ops-access-hub](../ops-access-hub/) (`/cases` routes), so a later session can recall a prior investigation instead of re-diagnosing from scratch.

## How it works

Three model-facing tools, plus prompt wiring through `ops-prompts`:

- **`knowledge_search`** — keyword search over the case index (title ×3 / tags ×2 / symptoms ×2, substring, case-insensitive), returning the top full cases. The doctrine tells the agent to search *before* starting a diagnosis.
- **`knowledge_record`** — distill a resolved investigation into a case; with an `id` it updates the existing case instead (the doctrine says: search first, update near-duplicates, create only when nothing matches). Beyond the conclusion (`symptoms` / `root_cause` / `fix`), a case can carry `methodology` — *how* the root cause was found (the discriminating steps/commands), for reuse in similar-but-not-identical situations — and a self-assessed `difficulty` (1–5); hard-won cases (≥3) are expected to record the methodology.
- **`knowledge_hit`** — mark a case as adopted by this investigation; `hitCount` ranks the session-start index, so useful cases float and unused ones sink.

Two prompt surfaces (registered via `ops-prompts`, same dual-mode `ctx.get`/`ctx.inject` resolution as ops-tool-trace):

- a static methodology section (search-first / record-on-resolve / hit-on-adopt discipline, plus the case quality bar);
- a once-per-session reminder at the first pre-step injecting the case index (title + symptoms, top 10 by hits). The reminder's `check` is synchronous, so the index is pre-fetched into memory at plugin start and refreshed after every mutation.

## Config

| Key | Default | Purpose |
|---|---|---|
| `hubUrl` | env `ACCESS_HUB_URL` | hub base URL, e.g. `http://127.0.0.1:3090` |
| `hubToken` | env `ACCESS_HUB_READ_TOKEN` | hub token — the **read** token suffices (the hub deliberately accepts read-role writes on `/cases`; cases hold no secrets) |

With neither config nor env set, the plugin logs one line and no-ops — no tools, no prompts. When the hub is unreachable at runtime, tools return an error *result* (never a throw) and the reminder stays silent: knowledge problems must never break a session.

## Wiring

Preset plane: one row inside the `ops-orchestration` isolate realm group (it consumes `opsPrompts`):

```yaml
- id: tool-ops-knowledge
  name: '@elinpf/dsh-ops-knowledge'
  # optional; env fallback covers it
  config:
    hubUrl: http://127.0.0.1:3090
    hubToken: <read-token>
```

The shipped `ops` preset (`packages/ops/presets/ops/agent.cordis.yml`) already carries this row without config, driven by the process env.

## Testing

```sh
npm run build     # tsc → lib/
npx vitest run    # scoring units, export shape, HMR unload, no-hub no-op,
                  # full tool chain against an in-process hub server
```
