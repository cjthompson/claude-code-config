# textual Tests

Tests for the `textual` plugin skills.

## Overview

The textual plugin contains two reference skills. No co-located test directories exist
yet, but test scenario files live here in `tests/plugins/textual/`.

**Skills:**
- `plugins/textual/skills/textual-css-reference/SKILL.md` — Valid Textual CSS properties
- `plugins/textual/skills/textual-api-reference/SKILL.md` — Textual widget API reference

## Test Files

| File | Skill Tested | Scenarios |
|------|-------------|-----------|
| [test-textual-css-reference.md](test-textual-css-reference.md) | textual-css-reference | 4 scenarios |
| [test-textual-api-reference.md](test-textual-api-reference.md) | textual-api-reference | 4 scenarios |

## How to Run

For each test file:
1. Open the test file and read each `# Test:` scenario
2. Dispatch a subagent with the **Prompt** from the test
3. Evaluate the response against **MUST Contain** and **MUST NOT Contain** criteria
4. Record pass/fail in [test-results.md](test-results.md)

**With the skill (GREEN pass):**
Prepend the relevant SKILL.md content to the subagent's system prompt before running.

**Without the skill (RED/baseline pass):**
Run the prompt with no skill context — document what the unguided agent says.

## Adding New Scenarios

Add a new `# Test: <Title>` block to the relevant test file, following the format:

```markdown
# Test: <Title>

## Prompt
"<The question or task the agent will be given>"

## MUST Contain
- item 1
- item 2

## MUST NOT Contain
- item 1
- item 2
```

**Record results in:** [test-results.md](test-results.md)
