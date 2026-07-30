# lean-agents Tests

Tests for the `lean-agents` plugin's sub-agent routing rules.

## Overview

Unlike the other plugins here, `lean-agents` ships **agent definitions**, not a skill — so
there is no `skills/` directory and the tests live at the plugin root. What is under test is
the *routing guidance*: the plugin-scoped `CLAUDE.md` plus the per-agent escalation sections.

**Rules location:** `plugins/lean-agents/CLAUDE.md` and the `## Self-Escalation` /
`## Available Tools` sections of `plugins/lean-agents/agents/*.md`

## Test Files

Located at `plugins/lean-agents/tests/`:

| File | Purpose |
|------|---------|
| `scenarios.md` | 8 routing scenarios defining the expected escalation decisions |
| `baseline-results.md` | RED — pass A (bare rosters) and pass B (OLD v0.0.54 guidance) |
| `green-results.md` | GREEN — results with the current guidance |

## Three-pass design

The standard two-pass RED/GREEN does not fit this component, because the before-state is not
"no instructions" — it is *different* instructions. So:

| Pass | Context given | Purpose |
|---|---|---|
| A (RED) | Bare tool rosters only | Measures the model's unaided prior |
| B (RED) | The OLD v0.0.54 guidance | **The real baseline** — what the shipped docs said |
| GREEN | The current guidance | The change under test |

Pass A alone is misleading: it turned out 7/7 correct, so a naive "GREEN closes A's gaps"
criterion is unsatisfiable. Pass B is what the change actually replaces.

## Scenarios

| Scenario | What It Tests |
|----------|---------------|
| 1 Text search only | Stays low; uses `rg`/`grep` via Bash, no escalation |
| 2 Filename/path search only | Stays low; uses `rg --files`/`find`, no escalation |
| 3 Semantic navigation | **Guard rail** — correctly escalates for `LSP` |
| 4 Search + cron | **Guard rail** — search stays low, only cron escalates |
| 5 Unbounded search hazard | Bounds the command (scope, `-l`, `head`, excludes `node_modules`) |
| 6 Agent that has Grep/Glob | `main`/`full-executor` prefer native tools over shelling out |
| 7 Clarifying question needed | **Guard rail** — correctly escalates for `AskUserQuestion` |
| 8 Self-escalation inside standard-executor | The targeted mechanism: execute, bounded, don't escalate |

Scenario 8 is the most important: 1–7 ask a *parent* which profile to pick, but the guidance
this change fixes governs `standard-executor` deciding **about itself** mid-task. Scenarios 3,
4 and 7 are guard rails — they fail if the change over-corrects into "never escalate."

## Pass criteria

Tests pass when, against pass B:

1. Scenarios 1, 2, 5, 6, 8 are correct and **no worse** than pass B, and
2. Guard rails 3, 4, 7 **still escalate** (no over-correction), and
3. Scenario 8 produces a **bounded, gitignore-aware** command without escalating.

Note criterion 1 says "no worse," not "better." Pass B scored well on routing, so the
achievable delta is concentrated in scenario 8 (search hygiene) rather than in escalation
counts. See [test-results.md](test-results.md) for what was and was not demonstrated.

## How to Run

1. Open `plugins/lean-agents/tests/scenarios.md`
2. **Pass A:** dispatch a haiku subagent with the scenario text plus a bare list of each
   profile's tool roster; record in `baseline-results.md`
3. **Pass B:** repeat with the OLD guidance text (recover it from git history, e.g.
   `git show v0.0.54:plugins/lean-agents/CLAUDE.md`); record in `baseline-results.md`
4. **GREEN:** repeat with the current `CLAUDE.md` and agent search/escalation guidance
   prepended; record in `green-results.md`
5. For scenario 8, give the subagent the full `standard-executor.md` definition as its system
   prompt and the parent instruction from the scenario
6. Instruct every pass to answer without using tools, so the comparison is about reasoning

**Record results in:** [test-results.md](test-results.md)

## Known Limitation

The subagent runs inside this repo, so the plugin-scoped `CLAUDE.md` may be auto-injected into
its context, contaminating passes A and B with the *new* rules. Every pass explicitly instructs
the subagent to answer only from the prompt text, which mitigates but does not eliminate this.
Treat the RED passes as a floor on the improvement, not an exact measure.

## Adding New Scenarios

Add a new `## Scenario N: <Name>` section to `scenarios.md`, following the existing format.
Run all three passes and record results.
