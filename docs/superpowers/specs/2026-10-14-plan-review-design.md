# Plan Review Skill — Design

Status: draft, awaiting review
Date: 2026-10-14

## Goal

Critique an LLM-generated plan before anyone executes it. The review runs as narrow, independent checks (categories), grouped into named reviewer personas. Each check runs as its own read-only subagent. The result is a report of ranked findings with proposed revisions. The reviewed plan is never edited.

## Scope

In scope:

- Plan types: implementation, technical, brainstorming (high-level requirements).
- A plugin `plan-review` containing one skill, `plan-review`.
- Category briefs, persona definitions, and a shared reviewer prompt, stored as reference files.
- A report written to `docs/plan-reviews/` in the reviewed project.

Out of scope (non-goals):

- Editing the plan. Revisions are proposed in the report and applied only after the user approves.
- Reviewing code diffs. Plan-referenced code is checked only as far as the plan's claims about it (see Open decisions).
- Replacing `project-tasks` plan ingestion or `superpowers:writing-plans`.

## Plan types and classification

The orchestrator classifies the plan from its content:

- **implementation:** file paths, ordered tasks, test or verification commands.
- **technical:** architecture, interfaces, data flow, trade-offs.
- **brainstorming:** goals, users, success criteria, and no implementation detail.

An explicit `--type` argument overrides classification. If signals conflict or the plan is mixed, the orchestrator asks the user one question before dispatching.

## Categories

A category is one narrow review brief with one question and one evidence method. Each category is one reviewer agent per run.

| Category | Question it answers | Evidence method |
|---|---|---|
| correctness | Do the plan's claims hold? | Grep/Read the repo for referenced files and symbols |
| reuse | Does the plan rebuild something that exists? | Grep the repo for existing equivalents |
| simplicity | Is there over-engineering or a simpler route? | Reasoning, plus repo precedent |
| best practices | Does it follow `CLAUDE.md` and repo conventions? | Read `CLAUDE.md` and sibling code |
| test coverage | Does each behavior have a test, including failure paths? | Reasoning over the plan's test steps |
| scope | Does the plan add or omit work relative to the request? | Compare plan against the user's request |
| ordering | Are dependencies, blockers, and rollback correct? | Reasoning over task order |
| verification | Does each step have a runnable check? | Confirm the commands exist in the repo |
| security | Are auth, data exposure, and input surfaces handled? | Reasoning, plus Grep for existing patterns |
| scale | Do query patterns, hot paths, or growth break the design? | Reasoning, plus Read of the affected code |
| goal coverage | Does each stated goal map to a deliverable? | Compare goals against plan deliverables |
| assumptions | Are unstated premises or insider knowledge required? | Reasoning, zero-context reading |
| feasibility | Are third-party tool or API claims true? | WebFetch of official documentation |

## Personas

A persona is a named set of categories. Stances are modifiers applied to a run, not categories.

| Persona | Categories |
|---|---|
| Engineer | correctness, reuse, simplicity, best practices, test coverage |
| Architect | simplicity, reuse, scale, security, feasibility |
| Product manager | goal coverage, scope, assumptions |
| Operator | ordering, verification, scale |

| Stance | Effect |
|---|---|
| Contrarian | Reviewer assumes the plan failed and traces back why. |
| Outsider | Reviewer reads with no insider context. Applied mainly to `assumptions`. |

Default personas by plan type:

- technical: Engineer + Architect (8 categories).
- implementation: Engineer + Operator (8 categories).
- brainstorming: Product manager, with the Outsider stance (3 categories).

Users may combine personas or name categories directly (for example `--personas engineer,product-manager` or `--categories correctness,scope`).

## Dispatch

- The run's category set is the deduplicated union of the selected personas' categories. A category shared by two personas runs once.
- **Cap: 8 categories per run.** The defaults above sit at or under the cap. If a custom mix exceeds it, the orchestrator lists the selection and asks which to drop. It never drops silently.
- Each category is one `lean-agents:read-only` subagent, dispatched in parallel.
- Each agent receives: the plan path, the user's request, the project root, the plan type, any active stance, and its single category brief from `references/categories.md`. It starts with fresh context and no author reasoning.
- Write guard: `Bash` is not mechanically read-only, so the no-writes rule is stated in the reviewer prompt. The rule is prompt-enforced, not tool-enforced.

## Reviewer output contract

Defined in `references/reviewer-prompt.md`. Each agent returns either `NO FINDINGS` or up to 5 findings. Each finding is exactly three lines:

```
[SEVERITY] <category> — <plan section>: <claim>
EVIDENCE: <contradiction and source path:line or URL>  |  CONCERN: <risk>; checked: <what was checked>; settles it: <what would settle it>
Fix: <proposed revision for that section>
```

Severity:

- **Critical:** the plan cannot succeed as written, or it causes data loss or security exposure.
- **High:** likely rework.
- **Medium:** a quality gap that should be fixed in this iteration.
- **Low:** minor.

Rules:

- `EVIDENCE` requires a source. A `CONCERN` needs no source but must say what was checked and what would settle it.
- A reviewer that finds nothing must reply `NO FINDINGS`. It must not invent findings.
- Each reviewer's reply is at most 15 lines (5 findings × 3 lines).

## Orchestrator merge

1. Classify the plan and select personas or categories.
2. Dispatch the agents in parallel and collect their replies.
3. Dedupe: findings with the same plan section and the same claim merge. Keep the highest severity and record every contributing category.
4. Drop a `CONCERN` when an `EVIDENCE` finding on the same section covers it.
5. Rank by severity. Within a severity, show findings that multiple categories raised first.
6. Build "What You Lose": strong dissent that the merged list would otherwise hide. Include any High or Critical finding raised by one category when another category contradicts it.

## Report

Written to `docs/plan-reviews/YYYY-MM-DD-<slug>-review.md` in the reviewed project. `<slug>` derives from the plan's filename.

Sections, in order:

1. **Summary:** plan type, personas, categories run, skipped categories with reasons, and counts by severity.
2. **Findings:** merged and ranked.
3. **Proposed revisions:** grouped by plan section. Each is marked "not applied."
4. **What You Lose:** minority dissent.

The skill's chat reply shows the summary and the report path. The plan file is never modified. Applying a revision is a separate step that needs user approval.

## Plugin layout

```
plugins/plan-review/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  .cursor-plugin/plugin.json
  skills/plan-review/
    SKILL.md                      orchestrator: classify, dispatch, merge, report
    references/categories.md      one brief per category
    references/personas.md        persona and stance definitions, plan-type defaults
    references/reviewer-prompt.md shared subagent prompt, output contract, severity
    tests/                        scenario tests (see Testing)
```

`SKILL.md` frontmatter: `name: plan-review` and a trigger-focused description, for example "Use when the user asks to review, critique, or check an LLM-generated plan before executing it." The skill has no `model:` field, so the Opus verification loop in `CLAUDE.md` is not triggered.

Catalog changes:

- Add entries to `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, and `.cursor-plugin/marketplace.json`.
- Add a row to the `README.md` plugin table.
- Plugin version starts at `0.1.0`.
- Version bump, `CHANGELOG.md`, and `README.md` updates follow `CLAUDE.md` after the merge to `main`, not on the feature branch.

## Testing

- **Structure test:** `tests/plugins/plan-review/structure.test.mjs`, following the pattern in `tests/plugins/project-tasks/structure.test.mjs`. It checks that plugin manifest versions match marketplace entries.
- **Test index:** `tests/plugins/plan-review/index.md` and `test-results.md`, plus a README table row.
- **Scenario tests:** per `tests/README.md`. Write `tests/scenarios.md` and run baseline (no skill) and green (with skill) passes with a haiku subagent.
- **Planted-defect scenarios:**
  - An implementation plan that references a nonexistent path and has a task with no verification step. Expected: an `EVIDENCE` finding for the path and a `verification` finding.
  - A brainstorming plan with one goal that no deliverable covers. Expected: a `goal coverage` finding.
  - A clean plan. Expected: `NO FINDINGS` from most reviewers, with no invented findings.
- **Report check:** the report has all four sections, and the plan file's hash is unchanged after the run.

## Open decisions

These are defaults used in this draft. Each needs confirmation.

1. **Scope:** plan-only review. Alternative: also review code the plan references, which would widen the category pool.
2. **Dispatch cap:** 8 categories per run, so up to 8 agents. Alternative: 6, which would force the defaults to change.
3. **Findings format:** up to 5 findings per reviewer, each three lines. This replaces the earlier "15 lines total" cap.
4. **Model:** reviewers inherit the session model. Alternative: pin a cheaper model for simple categories.
5. **Report location:** `docs/plan-reviews/` in the reviewed project.

## Sources and confidence

- **council-review (`ngmeyer`):** the five advisors and the chairman synthesis, adapted into the merge step. Read via WebFetch summary.
- **Florian `review-plan`:** four review axes. Read via WebFetch summary. Its DRY preference is not adopted as a default.
- **`wrsmith108/plan-review-skill`:** severity ranking and the approval gate. Read via WebFetch summary. Department-style personas were not adopted.
- **`serbanghita` plan critique:** feasibility and evidence checks. Read via WebFetch summary.
- **`michaelbarton/dotfiles` PR #138:** evidence and concern finding types, and fresh-context isolation. Read via WebFetch summary. The PR's state (open or merged) and exact wording are unverified.
- **Fluent-AI-Pod `plan-review` and microsoft `review-plan`:** not verified. The first returned no SKILL.md content, and the second returned HTTP 403.
