# agent-team-development Tests

Tests for the `agent-team-development` plugin skill.

## Overview

This skill is tested via scenario-driven LLM evaluation. A haiku subagent is dispatched
with each scenario — first without the skill (baseline/RED), then with the skill prepended
(GREEN). Results are compared to measure skill effectiveness.

**Skill location:** `plugins/agent-team-development/skills/agent-team-development/SKILL.md`

## Test Files

Located at `plugins/agent-team-development/skills/agent-team-development/tests/`:

| File | Purpose |
|------|---------|
| `scenarios.md` | 7 test scenarios defining expected agent behavior |
| `baseline-results.md` | RED phase — results without the skill (what unguided agents do) |
| `green-results.md` | GREEN phase — results with the skill (correct behavior) |

## Scenarios

| # | Scenario | What It Tests |
|---|----------|---------------|
| 1 | Team design | Assigns appropriate roles and sizes teams correctly |
| 2 | Worktree isolation decision | Decides when to use worktrees vs shared workspace |
| 3 | Integration ordering | Cherry-pick ordering and merge conflict prevention |
| 4 | Conflict resolution | Handling merge conflicts across worktrees |
| 5 | Shutdown ordering | Correct team shutdown and cleanup sequence |
| 6 | Crashed teammate recovery | Detecting and recovering from a failed subagent |
| 7 | Shipping strategy | Choosing between PR, direct merge, or cherry-pick |

## How to Run

1. Open `plugins/agent-team-development/skills/agent-team-development/tests/scenarios.md`
2. For each scenario, dispatch a haiku subagent with **only the scenario text** (no SKILL.md)
3. Record the response in `baseline-results.md`
4. Re-run with the SKILL.md contents prepended to the system prompt
5. Record the response in `green-results.md`
6. Compare: GREEN results should address all gaps found in baseline

**Record results in:** [test-results.md](test-results.md)

## Adding New Scenarios

1. Add a new `## Scenario N: <Name>` section to `scenarios.md`
2. Include: setup context, user utterance, expected behavior, failure criteria
3. Run a baseline pass and add result to `baseline-results.md`
4. Run a GREEN pass with the skill and add result to `green-results.md`
