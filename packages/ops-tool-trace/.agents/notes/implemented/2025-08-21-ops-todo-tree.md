# Agent Note: ops-todo-tree investigation tree plugin

Status: implemented

## Context

The ops preset used the standard `todo_write` tool — a flat list that doesn't capture investigation structure. For incident response, the agent needs to track branching exploration paths, dead ends, milestones, and a convergence to resolution. A tree model fits better than a flat list.

## Decision

Built `@elinpf/dsh-ops-todo-tree` — a single-package dual-half plugin that replaces `todo_write` in the ops preset:

- **Host half** (`src/index.ts`): registers the `todo_tree` model tool (8 actions), a `sessionProjections` unit (incremental fold, key `todo_tree`), and a system prompt section.
- **Client half** (`src/client.ts`): registers a `conversation.view` tab ("调查树") that renders a git-graph-style flat list with SVG lane lines, branch connectors, status glyphs, and expandable rows.
- **Event model**: 7 incremental event types (`todo_tree/create`, `add`, `start`, `complete`, `abandon`, `resolve`, `note`). Projection folds these into a `TreeState` via a pure function.
- **State machine**: 6 statuses (`goal`, `pending`, `in_progress`, `done`, `dead_end`, `resolved`) with 8 legal transitions. `dead_end` is NOT terminal — can re-explore.
- **Lane/depth**: derived client-side, not stored in the log. `branch=true` on `add` allocates a new lane.
- **Subagent integration**: subagents have independent sessions and cannot write to the tree directly. The main agent relays their results.

## Alternatives considered

1. **Whole-value last-wins events** (like `goals` projection): rejected during 09 grilling — the user pointed out that re-sending the entire tree on every operation wastes space. Switched to incremental events + projection fold.

2. **Dead end as terminal leaf node** (original 05 design): rejected during 05 grilling — the user noted that "marking something as a dead end doesn't mean it's truly impossible; continuing to explore it might find valuable info." Simplified to: `dead_end` is just a mark, not a terminal state, no cascade, no leaf constraint.

3. **rootCause + fix fields on resolved**: rejected during 05 grilling — too ops-specific. Generalized to a free-text `summary` field.

4. **Subagent directly operates the tree**: rejected during 10 research — DSH subagents have independent sessions (`SessionId(randomUUID())`), so they can't write to the main agent's session. Main agent relays results instead.

5. **react-flow for rendering**: rejected during 04/08 prototyping — self-drawn SVG proved sufficient and more controllable for the git-graph layout.

6. **Local file plugin** (like k8s-plugin): rejected during 07 research — local file plugins cannot carry a client half. Switched to a single npm package with dual halves (following `dsh-client-ui-cordis` pattern).
