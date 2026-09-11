# @elinpf/dsh-ops-tool-trace

The investigation-tree tool for DeepSeek Harness ops mode: replaces todo-style flat checklists with a diverge-converge tree of hypotheses, steps, dead ends, and a resolved terminal — an external memory that survives context compaction.

## What it does

The agent maintains the tree through the `trace` model tool. Every call appends an incremental event to the session log; the `trace` session projection (registered host-plane by `@elinpf/dsh-ops-trace-ui`, definition shared from this package so the two can never drift) folds the events into the current forest state, which the web panel renders. A session holds a FOREST: resolved trees are kept for reference, the active tree is the latest unresolved one.

- **11 actions**: `create_tree`, `add_step`, `add_milestone`, `start`, `complete`, `abandon`, `reopen`, `resolve`, `link`, `view`, `help`
- **6 statuses**: `goal`, `pending`, `in_progress`, `done`, `dead_end`, `resolved`
- **Milestones are falsifiable hypotheses** — writable only in the form "我怀疑 X, 因为看到了 Y"; `abandon` on a milestone is the 证伪 (disproof) operation
- **Dead ends are kept, not deleted** — they are the record that prevents re-investigating a disproven path; `reopen` revives a wrongly closed node
- **`link`** records causal edges (`caused_by`) without changing status — proof is `complete` with a summary, not a link
- **`resolve(goal)` is hard-gated**: every non-root node must be decided (`done`/`dead_end`) first. `force: true` is the escape hatch for ABANDONING an investigation mid-way — the result's WARN names every node it shelved and marks the closure an unverified assertion
- **`view`** renders the full tree (default) or an indented outline (`format: tree`); **`help`** progressively discloses the full doctrine

## The one structural rule

`parent_id` answers a single question — 我为什么现在要做这个动作? (why am I doing this NOW): follow-up on a step's finding → hang under that step; verifying a hypothesis → under its milestone; a top-level hypothesis → under `goal`. The `add_step` flat-hang hint and the `trace:nesting` reminder both enforce this shape.

## Reminders (via ops-prompts)

Three just-in-time reminder rules fire on agent pre-step when the tree's hygiene slips; each is a pure function of a derived `ReminderContext` (step positions from the event log + the live forest) behind a `ReminderLatch` (min gap with doubling backoff, per-session):

- **`trace:idle`** — no trace update for 5+ steps mid-investigation (gap doubles per fire up to 40 steps, resets when the agent complies)
- **`trace:nesting`** — steps pile up flat under milestones while completed steps already carry findings (drill deeper instead)
- **`trace:stale-step`** — an open step (pending/in_progress) has gone 4+ turns without a decision: complete it with a summary, abandon it (a dead end is a result), or record what it waits for in `detail`

## Design notes

- **Preset-plane only.** This package carries the tool, the doctrine (system-prompt section + reminders via ops-prompts), and the projection DEFINITION; it registers no projection itself — `@elinpf/dsh-ops-trace-ui` does that host-plane (the web surface discovers panels by scanning host entries) and owns the panel. The panel hides itself when the projection carries no trace data — that is by design, not a bug.
- **Events are the truth.** State is a left-fold over the session event log (`foldEvent`, `stateVersion: 5`); the in-memory store re-seeds from the projection after HMR and survives compaction — the tree is the agent's compaction-proof working memory.
- **Errors teach.** Rejected calls say what to do instead (the resolve gate lists undecided nodes; abandoning the root goal points at `resolve`; a corrupt transition names both states).

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `idleReminderGapSteps` | `5` | Steps without a trace update before the idle reminder fires |
| `idleReminderBackoffCeilingSteps` | `40` | Ceiling for the idle reminder's doubling refire gap |
| `nestingReminderFlatSteps` | `3` | Flat milestone-hung steps that arm the nesting reminder |
| `staleStepReminderTurns` | `4` | Turns an open step may sit undecided before the stale-step reminder fires |

## Installation

Shipped in the `@elinpf/dsh-ops` suite preset (`ops-orchestration` group, sharing an isolate realm with ops-prompts). Standalone, reference it in the preset's `agent.cordis.yml` — and remember the tool is invisible in the UI without `@elinpf/dsh-ops-trace-ui` on the host plane:

```yaml
- id: tool-ops-trace
  name: '@elinpf/dsh-ops-tool-trace'
```

## Testing

`vitest run` — tool actions and transitions, projection fold (incl. rejected resolves never closing the tree), the session-forest store, reminder rules as pure functions of hand-built contexts, doctrine text invariants, and HMR unload (tool, methodology, and all reminders leave their registries with the fiber).

## Known limitations

- Subagents cannot write to the tree directly — the main agent relays their results
- Lane/depth layout is derived client-side, never stored
- No replay/timeline scrub UI (the events are in the session log)
