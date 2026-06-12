---
name: skill-testing
description: Use when creating test scenarios for a skill, setting up a tests/ directory for a plugin or package, running skill tests against a subagent, or verifying whether a SKILL.md changes agent behavior
---

# Skill Testing

## Overview
Structured approach for verifying that skills (SKILL.md files) actually change agent behavior. Two passes: baseline (no skill → documents failure) and GREEN (skill present → verifies success). Results recorded in test-results.md.

## Directory Structure

Mirror `plugins/` and `packages/` exactly under a `tests/` root:

```
tests/
├── README.md
├── test-results.md                      # master index
├── plugins/
│   └── <plugin-name>/
│       ├── index.md                     # test inventory + instructions
│       ├── test-results.md             # execution history
│       └── test-<skill-name>.md        # scenarios (one file per skill)
└── packages/
    └── <package-name>/
        ├── index.md
        └── test-results.md
```

**Plugin or package?** Skills that live in `plugins/<name>/skills/` go under `tests/plugins/<name>/`. Skills that live in `packages/<name>/` go under `tests/packages/<name>/`.

## Test Scenario File Format

`tests/plugins/<plugin>/test-<skill-name>.md` — one or more scenarios per file:

```markdown
# Test: <Descriptive Title>

## Prompt
"<Exact question or task to give the agent>"

## MUST Contain
- specific fact, API name, or exact string that must appear
- another required element

## MUST NOT Contain
- the wrong answer agents produce without the skill
- an invalid approach the skill explicitly forbids
```

**MUST Contain items come from the skill itself** — they are the exact facts, names, and values the SKILL.md explicitly teaches. If it's not in the skill, it can't be a MUST.

**MUST NOT items come from the baseline run** — they are the specific wrong things unguided agents say. Don't write MUST NOT items before running baseline.

## Running Tests

### Step 1: Baseline (RED — no skill)
Dispatch a subagent with only the prompt. No SKILL.md. Record exactly what the agent says — this reveals what MUST NOT be in the correct answer.

### Step 2: GREEN — with skill
Prepend the full SKILL.md to the subagent's system prompt. Run the same prompt. Check every MUST and MUST NOT item.

### Step 3: Record results
Append to `tests/plugins/<plugin>/test-results.md`:

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-06-12 | Valid layout property values | PASS | — |

## Evaluating Correctness

| Condition | Status |
|-----------|--------|
| All MUST items present, no MUST NOT items present | **PASS** |
| Some MUST items missing | **FAIL** |
| Any MUST NOT item present | **FAIL** |
| Some MUST present, none missing | **PARTIAL** |

## What Makes a Good Test Scenario

| Good | Bad |
|------|-----|
| Tests one specific fact | Tests vague "general understanding" |
| MUST NOT items are things agents *actually* say wrong | MUST NOT items are implausible |
| Prompt is something a real user would ask | Prompt is a trick question |
| 3–5 MUST items per scenario | 10+ MUST items (too broad to fail cleanly) |
| Skill is the only way to get it right | Available in general training data |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| No baseline run | Run without skill first — MUST NOT items come from what unguided agents say |
| Vague MUST Contain ("mentions Button") | Be exact: "`Button.Pressed` message with `.button` attribute" |
| One scenario file per scenario | One file per *skill*, multiple `# Test:` blocks inside |
| Skipping test-results.md | Record every run — history reveals regressions when skills are edited |
| GREEN pass only | Baseline is essential — without it you don't know if the skill is doing anything |
