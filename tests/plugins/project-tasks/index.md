# project-tasks Tests

Tests for the `project-tasks` plugin skill.

## Overview

The project-tasks skill has the most developed test suite in this repo. Two layers:

1. **Individual behavior tests** (`test-*.md`) — each covers a specific workflow or
   edge case, with explicit setup, scenario, expected behavior, and failure criteria
2. **Phase results** (`baseline-results.md`, `green-results.md`) — cumulative RED/GREEN
   evaluation across all scenarios

**Skill location:** `plugins/project-tasks/skills/project-tasks/SKILL.md`
**Skill model:** `haiku` (as specified in SKILL.md frontmatter)

## Test Files

Located at `plugins/project-tasks/skills/project-tasks/tests/`:

| File | Purpose |
|------|---------|
| `test-log-task.md` | Logging tasks to SQLite with correct format and fields |
| `test-run-task.md` | Single-agent dispatch; validates context payload minimality |
| `test-2stage-pipeline.md` | Sonnet scout + Haiku executor pipeline with TaskList sync |
| `test-changelog.md` | Changelog generation from completed tasks |
| `test-project-discovery.md` | 3-tier project identifier discovery |
| `baseline-results.md` | RED phase — results without the skill |
| `green-results.md` | GREEN phase — results with the skill |

## Individual Test Format

Each `test-*.md` file follows this structure:
- **Setup** — file contents, database state, and environment needed
- **Scenario** — the user utterance and any follow-up choices
- **Expected Behavior** — numbered steps the agent must follow
- **Failure Criteria** — specific behaviors that constitute a test failure

## How to Run

**Individual test:**
1. Read the setup section and prepare the described environment
2. Dispatch a haiku subagent with the SKILL.md prepended + the test file content
3. Evaluate the response against the Expected Behavior and Failure Criteria

**Full evaluation:**
1. For each test file, run the scenario with and without the SKILL.md
2. Record results in `baseline-results.md` (without) and `green-results.md` (with)

**Record results in:** [test-results.md](test-results.md)

## Adding New Test Cases

1. Create `test-<behavior>.md` in `plugins/project-tasks/skills/project-tasks/tests/`
2. Follow the Setup / Scenario / Expected Behavior / Failure Criteria structure
3. Run a baseline pass (no skill) and a GREEN pass (with skill)
4. Add results to `baseline-results.md` and `green-results.md`
