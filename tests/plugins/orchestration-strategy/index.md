# orchestration-strategy Tests

Tests for the `orchestration-strategy` plugin skill.

## Overview

This skill is tested via scenario-driven LLM evaluation. A haiku subagent is dispatched
with each scenario — first without the skill (baseline/RED), then with the skill prepended
(GREEN).

**Skill location:** `plugins/orchestration-strategy/skills/orchestration-strategy/SKILL.md`

## Test Files

Located at `plugins/orchestration-strategy/skills/orchestration-strategy/tests/`:

| File | Purpose |
|------|---------|
| `scenarios.md` | Test scenarios defining expected orchestration decisions |
| `baseline-results.md` | RED phase — results without the skill |
| `green-results.md` | GREEN phase — results with the skill |

## Scenarios

| Scenario | What It Tests |
|----------|---------------|
| High file overlap | Recommends sequential execution to avoid conflicts |
| Independent, no overlap | Recommends parallel agents in a shared worktree |
| Independent with overlap | Recommends parallel agents each with their own worktree |
| Cross-cutting refactor | Recommends Agent Teams for coordinated cross-file work |
| Simple single task | Recommends solo execution (no parallelism overhead) |
| Worktree cost-benefit | Correctly weighs isolation cost vs parallelism benefit |
| Teams not available | Falls back gracefully when Agent Teams can't be used |

## How to Run

1. Open `plugins/orchestration-strategy/skills/orchestration-strategy/tests/scenarios.md`
2. For each scenario, dispatch a haiku subagent with **only the scenario text** (no SKILL.md)
3. Record the response in `baseline-results.md`
4. Re-run with the SKILL.md prepended
5. Record the response in `green-results.md`

**Record results in:** [test-results.md](test-results.md)

## Adding New Scenarios

Add a new `## Scenario N: <Name>` section to `scenarios.md`, following the existing format.
Run RED and GREEN passes and record results.
