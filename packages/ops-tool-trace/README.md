# @elinpf/dsh-ops-tool-trace

An investigation tree tool for DeepSeek Harness ops mode — replaces `todo_write` with a diverge-converge tree of steps, milestones, dead ends, and a resolved terminal.

## What it does

Agent-driven investigation tracking: the agent maintains a tree of investigation steps via the `todo_tree` model tool. Each call appends an incremental event to the session log; a session projection folds these into the current tree state; the client renders a git-graph-style flat list with colored lanes, expandable rows, and status glyphs.

- **8 actions**: `create_tree`, `add_step`, `add_milestone`, `start`, `complete`, `abandon`, `resolve`, `note`
- **6 statuses**: `goal`, `pending`, `in_progress`, `done`, `dead_end`, `resolved`
- **Dead ends are not deleted** — they stay on the tree as part of the exploration record
- **Branch** with `branch=true` to explore side paths in parallel lanes
- Every call returns the full tree + a status summary (advisor, not gatekeeper)

## Installation

Add to `dsh-web-app` dependencies and reference in the ops preset's `agent.cordis.yml`:

```yaml
- id: tool-ops-trace
  name: '@elinpf/dsh-ops-tool-trace'
```

## Model Experience

### todo_tree tool

#### What the model sees

A tool description explaining the 8 actions and when to use each. A system prompt section with usage guidance.

#### Token effect

Tool schema + description (~200 tokens). System prompt section (~300 tokens).

#### KV Cache effect

Stable across turns — tool description and prompt section are static.

## Known Limitations and Deferred Work

- No cross-session continuity (v1: one tree per session)
- No human editing (pure agent-driven)
- Lane/depth computed client-side (layout is derived, not stored)
- Subagents cannot directly write to the tree — main agent must relay their results
- No replay/timeline scrub UI (events are in the session log, but no dedicated timeline view)
