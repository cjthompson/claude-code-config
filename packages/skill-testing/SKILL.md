---
name: skill-testing
description: Use when creating test scenarios for a skill, setting up a tests/ directory for a plugin or package, running skill tests against a subagent, or verifying whether a SKILL.md changes agent behavior
---

# Skill Testing

## Overview
Structured approach for verifying that skills (SKILL.md files) actually change agent behavior. Two passes: baseline (no skill → documents failure) and GREEN (skill present → verifies success). A separate Haiku judge agent evaluates every response against the checklist — the orchestrating agent never judges output itself.

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

**MUST Contain items come from the skill itself** — they are the exact facts, names, and values the SKILL.md explicitly teaches. If it's not in the skill, it can't be a MUST. MUST items must be naturally triggered by the prompt — if the prompt doesn't invite a topic, don't add a MUST for it.

**MUST NOT items come from the baseline run** — they are the specific wrong things unguided agents say. Don't write MUST NOT items before running baseline. Phrase them as **recommended as correct**, not merely **mentioned** — an agent that says "don't use `display: flex`" has not violated a MUST NOT about `display: flex`. Write: "`display: flex` recommended as a working approach" not "`display: flex` appears in response".

## Running Tests

### Step 1: Baseline (RED — no skill)
Dispatch a subagent with only the prompt. No SKILL.md. Then dispatch the Haiku judge (see below) to evaluate the response. The judge output reveals what agents say without guidance — use this to populate MUST NOT items for any scenario that doesn't have them yet.

### Step 2: GREEN — with skill
Prepend the full SKILL.md to the subagent's system prompt. Run the same prompt. Then dispatch the Haiku judge with the GREEN response. The judge's verdict is the authoritative result.

### Step 3: Record results
Append to `tests/plugins/<plugin>/test-results.md` using the judge's verdict:

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-06-12 | Valid layout property values | PASS | — |
| 2026-06-12 | Invalid position properties | FAIL | Missing: dock alternative |

## The Judge Agent

After every run (baseline and GREEN), dispatch a **Haiku** subagent as judge. Haiku follows strict checklists reliably and is the right model for this mechanical verification task.

The judge receives the test scenario and the response text. It checks each MUST and MUST NOT item and returns a structured per-criterion verdict. The orchestrating agent never judges the response itself — only the judge's output counts.

**Judge prompt template:**

```
You are a test result verifier. Your only job is to check whether items from a
checklist appear or do not appear in a response. Do NOT load any skills. Do NOT
use your own knowledge to decide if an answer is correct — only check presence
or absence in the response text.

## Test Prompt (given to the tested agent)
{paste the exact prompt from the scenario}

## Response to Evaluate
{paste the full response from the tested agent}

## MUST Contain — check each item
For each item, respond PASS if the concept or value appears in the response,
FAIL if it does not. Include a short quote as evidence, or "not found".

{numbered list of MUST Contain items from the scenario}

## MUST NOT Contain — check each item
For each item, respond PASS if the concept does NOT appear, FAIL if it DOES.
Include a short quote if found, or "not found" if absent.

{numbered list of MUST NOT Contain items from the scenario}

## Verdict
Output exactly one of:
- PASS — all MUST items found AND no MUST NOT items found
- FAIL — any MUST item missing OR any MUST NOT item found
- PARTIAL — no MUST NOT items found, but some MUST items missing

List any failing criteria by number.
```

## Evaluating Correctness

The judge returns one of three verdicts:

| Verdict | Meaning |
|---------|---------|
| **PASS** | All MUST items present, no MUST NOT items present |
| **FAIL** | Any MUST item missing, OR any MUST NOT item present |
| **PARTIAL** | No MUST NOT items present, but some MUST items missing |

A PARTIAL on a GREEN run means the skill teaches the right direction but has gaps — add the missing content to the SKILL.md and re-run.

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
| Orchestrating agent judges output itself | Always dispatch the Haiku judge — self-judgment is biased |
| No baseline run | Run without skill first — MUST NOT items come from what unguided agents say |
| Vague MUST Contain ("mentions Button") | Be exact: "`Button.Pressed` message with `.button` attribute" |
| One scenario file per scenario | One file per *skill*, multiple `# Test:` blocks inside |
| Skipping test-results.md | Record every run — history reveals regressions when skills are edited |
| GREEN pass only | Baseline is essential — without it you don't know if the skill is doing anything |
