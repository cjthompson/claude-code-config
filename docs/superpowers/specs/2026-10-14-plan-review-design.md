# Plan Review Skill — Design

Status: draft, revision 2, awaiting review
Date: 2026-10-14 (revised 2026-10-16)

## Goal

Critique an LLM-generated plan before anyone executes it. The review is made of narrow, independent checks called categories. Named reviewer personas group those categories. Each category runs as its own read-only subagent. The output is a report of ranked findings with proposed revisions. The plan changes only when the user picks revisions to apply.

## Scope

In scope:

- Plan types: implementation, technical, and brainstorming (high-level requirements).
- A plugin named `plan-review` containing one skill, also named `plan-review`.
- Category briefs, persona definitions, and a shared reviewer prompt, stored as reference files.
- A review report file.
- Applying the revisions the user selects to the plan file.

Out of scope (non-goals):

- Reviewing code diffs. The skill checks code the plan references only as far as the plan makes claims about it (see Open decisions).
- Re-reviewing automatically after revisions are applied. The user runs the skill again if they want another pass.
- Stances: whole-run modifiers such as Contrarian ("assume it failed"). These are deferred to a later version. The Outsider reading is folded into the `assumptions` category brief.
- Replacing `project-tasks` plan ingestion or `superpowers:writing-plans`.

## Inputs

| Input | How it is supplied | Fallback when absent |
|---|---|---|
| Plan | Positional path argument. | If the conversation produced or referenced exactly one plan, propose that one and confirm it with the user. Otherwise ask for a path. |
| Inline plan | A plan that exists only in chat. | The orchestrator writes it verbatim to `${TMPDIR:-/tmp}/plan-review/<slug>.md` and uses that path as the plan. |
| Request | Taken from the conversation, or passed with `--request "<text>"`. | Recorded as "none". Categories that compare against a reference use the next reference source instead (see below). |
| Source | `--source <path>`, pointing at the spec or requirements document the plan derives from. | If the plan links to a file under a `specs/` directory or names one as its source, the orchestrator proposes that file and confirms it with the user. Otherwise there is no source. |
| Plan type | `--type` with `implementation`, `technical`, or `brainstorming` | Classified automatically (see below). |
| Selection | `--personas a,b` and/or `--categories x,y` | The default category set for the plan type. |

**Reference for `requirements coverage`.** The category checks the plan against the first of these that exists:

1. The source document.
2. The request.
3. The plan's own goal or requirements section.

The report states which reference was used. If none exists, the category is skipped and the report says so.

## Plan types and classification

The orchestrator classifies the plan from its content:

- **implementation:** file paths, ordered tasks, test or verification commands.
- **technical:** architecture, interfaces, data flow, trade-offs.
- **brainstorming:** goals, users, success criteria, and no implementation detail.

`--type` overrides classification. If the signals conflict or the plan is mixed, the orchestrator asks the user one question before dispatching.

## Categories

A category is one narrow review brief with one question and one evidence method. Each category runs as one reviewer agent.

| Category | Question it answers | Evidence method |
|---|---|---|
| correctness | Do the plan's claims hold? | Grep/Read the repo for the files and symbols it references |
| reuse | Does the plan rebuild something that already exists? | Grep the repo for existing equivalents |
| simplicity | Is there over-engineering, or a simpler route? | Reasoning, plus precedent in the repo |
| best practices | Does it follow `CLAUDE.md` and the repo's conventions? | Read `CLAUDE.md` and sibling code |
| test coverage | Does each behavior have a test, including failure paths? | Reasoning over the plan's test steps |
| requirements coverage | Does every requirement in the reference map to a deliverable, and does every deliverable trace back to a requirement? | Two-way comparison of the reference against the plan |
| scope | Is the scope boundary explicit: what is cut, deferred, or out of scope? | Reading of the plan |
| ordering | Are dependencies, blockers, and rollback correct? | Reasoning over task order |
| verification | Does each step have a runnable check? | Confirm the commands and scripts exist in the repo |
| security | Are auth, data exposure, and input surfaces handled? | Reasoning, plus Grep for existing patterns |
| scale | Do query patterns, hot paths, or growth break the design? | Reasoning, plus Read of the affected code |
| assumptions | Does the plan rely on unstated premises or insider knowledge? | A zero-context reading: the reviewer flags anything a newcomer could not act on |
| feasibility | Are claims about third-party tools and APIs true? | WebFetch of official documentation |

## Personas

A persona is a named set of categories. Users select personas with `--personas`.

| Persona | Categories |
|---|---|
| Engineer | correctness, reuse, simplicity, best practices, test coverage |
| Architect | simplicity, reuse, scale, security, feasibility |
| Product manager | requirements coverage, scope, assumptions |
| Operator | ordering, verification, scale |

Default category sets by plan type. These are explicit lists, not persona unions:

| Plan type | Categories | Derived from |
|---|---|---|
| implementation (8) | correctness, reuse, simplicity, best practices, test coverage, ordering, verification, requirements coverage | Engineer + Operator, with `scale` swapped for `requirements coverage` |
| technical (8) | correctness, reuse, simplicity, best practices, test coverage, scale, security, feasibility | Engineer + Architect |
| brainstorming (4) | requirements coverage, scope, assumptions, feasibility | Product manager + `feasibility` |

## Dispatch

- **Category set:** the deduplicated union of the selected personas' categories and any `--categories`. A category shared by two personas runs once.
- **Cap: 8 categories per run.** Each default is at or under the cap. If a custom selection exceeds it, the orchestrator lists the selection and asks which categories to drop. It never drops categories silently.
- **Parallel:** each category is dispatched as its own subagent, all in parallel.
- **Agent profile.** This copies the rule in `plugins/project-tasks/skills/project-tasks/SKILL.md:71-86`:
  1. If the host's agent roster includes the optional `lean-agents` plugin, use `lean-agents:read-only`. Never try that name on a host where it is absent.
  2. Otherwise, use a capability-equivalent read-only profile from the host.
  3. If the host has no read-only profile, use its general subagent and add this to the prompt: "You have write tools available only because the read-only profile is not installed. Do not use them. Do not modify any file." Tell the user: "Note: this host does not expose a structurally read-only subagent, so read-only enforcement is prompt-level for this review."
- **Write guard:** even `lean-agents:read-only` carries `Bash`, so the no-writes rule is always also stated in the reviewer prompt.
- **What each agent receives:**
  - the plan path
  - the request, or "none"
  - the reference document path for `requirements coverage`
  - the project root
  - the plan type
  - its single category brief from `references/categories.md`
  - the shared rules from `references/reviewer-prompt.md`

  The agent starts with fresh context and none of the plan author's reasoning.

## Reviewer output contract

Defined in `references/reviewer-prompt.md`. Each agent replies either `NO FINDINGS` or with 1 to 5 findings. Each finding is exactly three lines:

- **Line 1:** `[SEVERITY] <category> — "<plan heading, verbatim>": <claim>`
- **Line 2:** either `EVIDENCE:` or `CONCERN:`, never both.
- **Line 3:** `Fix:` and the proposed revision.

A finding that applies to the whole plan cites `"(whole plan)"` as its heading.

Example of an evidence finding:

```
[HIGH] correctness — "Task 3: Wire the parser": plan edits src/config/parse.ts, which does not exist
EVIDENCE: parser lives at src/config/parser.ts:12 (`parseConfig`); no file named parse.ts in the repo
Fix: change the Task 3 path to src/config/parser.ts and update the import in Task 4 to match
```

Example of a concern finding:

```
[MEDIUM] verification — "Task 5: Migrate settings": no step confirms the migration succeeded
CONCERN: migration could silently skip keys; checked: plan's Task 5 steps and package.json scripts; settles it: a test that loads a migrated fixture and asserts every key
Fix: add a step running `npm test -- migrate` against a fixture with every settings key
```

**Rules:**

- `EVIDENCE` must cite a source as `path:line` or a URL.
- `CONCERN` needs no source, but it must say what the reviewer checked and what would settle the question.
- A reviewer that finds nothing replies `NO FINDINGS` and must not invent findings.

**Severity definitions.** `reviewer-prompt.md` gives one example for each level:

| Severity | Definition | Example |
|---|---|---|
| Critical | The plan cannot succeed as written, or it causes data loss or security exposure | A migration step drops a table that has no backup step |
| High | Likely rework | The plan edits a file path that does not exist |
| Medium | A quality gap worth fixing in this iteration | A task with no verification step |
| Low | Minor | An inconsistent name between two tasks |

## Orchestrator merge

1. Classify the plan, resolve the inputs, and select the categories.
2. Dispatch the agents in parallel and collect their replies.
3. **Dedupe.** Group findings by their verbatim plan heading. Within a heading, the orchestrator decides which claims are the same issue. Merged findings keep the highest severity and list every category that raised them.
4. If an `EVIDENCE` finding covers a `CONCERN` under the same heading, drop the `CONCERN`.
5. **Rank** by severity. Within a severity level, findings raised by more than one category come first.
6. **Conflicts.** Under one heading, pair any two findings whose fixes oppose each other. An example is `simplicity` saying "drop the cache" while `scale` says "cache the results." Keep both fixes, show both sides, and leave the choice to the user.

## Report

**Location:**

- If the plan file is inside a git repository, write the report next to it as `<plan-stem>.review.md`.
- If the plan is outside a repository or is an inline plan's temp file, ask the user for a location before writing. "Chat only" is one of the choices.
- Writes follow the host's normal permission flow. In a repo whose hooks guard the main checkout, that may mean a permission prompt.

**Sections, in order:**

1. **Summary:**
   - plan type and categories run
   - skipped categories, with reasons
   - the reference used for `requirements coverage`
   - finding counts by severity
2. **Findings:** merged and ranked, each with a number.
3. **Proposed revisions:** grouped by plan heading. Each revision carries its finding number and a status of `not applied`.
4. **Conflicts:** paired opposing fixes, if any.

The chat reply shows the summary and the report path.

## Applying revisions

1. After writing the report, the orchestrator lists the proposed revisions in chat, numbered to match their findings. Paired conflicts are listed together.
2. The user replies with numbers, `all`, `critical+high`, or `none`. The reply is plain text, so this step works on every host.
3. **Conflicting fixes.** Selecting both sides of a conflict is rejected. The orchestrator asks which side to keep.
4. **Applying.** The orchestrator edits only the plan file and only the selected sections. Revisions to the same heading are applied top to bottom. If a revision no longer matches the text because an earlier edit changed it, the orchestrator skips it, marks it `skipped: text changed`, and tells the user.
5. **Status update.** Each revision's status in the report changes to `applied`, `skipped`, or `not applied`.
6. **Inline plans.** For a plan that was written to a temp file, the orchestrator edits the temp copy and prints its path.

The plan file is never modified before step 2, and never modified when the user answers `none`.

## Plugin layout

```
plugins/plan-review/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  .cursor-plugin/plugin.json
  skills/plan-review/
    SKILL.md                      orchestrator: inputs, classify, dispatch, merge, report, apply
    references/categories.md      one brief per category
    references/personas.md        personas and the default category set for each plan type
    references/reviewer-prompt.md shared subagent rules, output contract, severity examples
    tests/                        scenario tests (see Testing)
```

`SKILL.md` frontmatter is `name: plan-review` plus a trigger-focused description, for example: "Use when the user asks to review, critique, or check an LLM-generated plan, spec, or requirements doc before executing it." The skill has no `model:` field, so the Opus verification loop in `CLAUDE.md` is not triggered.

Catalog changes:

- Add entries to `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, and `.cursor-plugin/marketplace.json`.
- Bump `metadata.version` in `.cursor-plugin/marketplace.json`, which is currently `0.0.91`, because adding a plugin changes that catalog.
- Add a row to the `README.md` plugin table, and update its lists of plugins in the Codex and Cursor catalogs.
- The plugin version starts at `0.1.0`.
- The root `package.json` and `package-lock.json` version bump, the `CHANGELOG.md` entry, and any further `README.md` updates follow `CLAUDE.md` after the merge to `main`, not on the feature branch.

## Testing

- **Structure test:** `tests/plugins/plan-review/structure.test.mjs`, following `tests/plugins/project-tasks/structure.test.mjs`. It asserts the plugin name and version match across `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and the `.claude-plugin/marketplace.json` entry. It adds the `.cursor-plugin/plugin.json` version and the Cursor catalog entry, which the project-tasks test does not check.
- **Test index:** `tests/plugins/plan-review/index.md` and `test-results.md`, plus a row in the README table.
- **Scenario tests:** follow `tests/README.md`. Write `tests/scenarios.md`, then run a baseline pass (no skill) and a green pass (with the skill) with a haiku subagent.
- **Planted-defect scenarios:**
  1. **Implementation plan with a bad path and a missing check.** One task references a nonexistent path and another has no verification step. Expected: a `correctness` finding of type `EVIDENCE` citing the real path, and a `verification` finding.
  2. **Implementation plan that drops a spec requirement.** Pass the spec with `--source`. Expected: a `requirements coverage` finding naming the missing requirement.
  3. **Implementation plan that adds unrequested work.** Expected: a `requirements coverage` finding flagging a deliverable that traces to no requirement.
  4. **Brainstorming plan with an uncovered goal.** One goal has no deliverable and there is no request or source. Expected: a `requirements coverage` finding, with the report naming the plan's own goals as the reference.
  5. **Clean plan.** Expected: `NO FINDINGS` from most reviewers, and no invented findings.
  6. **Conflicting fixes.** A plan built so that `simplicity` and `scale` disagree. Expected: a Conflicts entry, and selecting both sides is rejected.
- **Apply checks:**
  - Answering `none` leaves the plan's hash unchanged.
  - Selecting a subset changes only those sections.
  - The report's revision statuses match what was applied.
- **Fallback dispatch:** run on a host or configuration without `lean-agents`. Expected: the prompt-level enforcement notice is shown to the user.

## Open decisions

These are the defaults used in this draft. Each one still needs confirmation.

1. **Review scope:** plan-only review. Alternative: also review code the plan references, which would widen the category pool.
2. **Dispatch cap:** 8 categories per run, which means up to 8 agents. Alternative: 6, which would require trimming the implementation and technical defaults.
3. **Model:** reviewers inherit the session model. Alternative: pin a cheaper model for mechanical categories such as `correctness` and `verification`.

## Revision log

- **Revision 2 (2026-10-16).** Addressed a self-review of revision 1:
  - added the Inputs section and `--source`
  - folded `goal coverage` into a two-way `requirements coverage` and redefined `scope`
  - made the default category sets explicit
  - reused the agent-profile fallback from `project-tasks`
  - defined the apply step
  - deferred stances
  - replaced the one-line output template with two examples
  - specified dedupe by verbatim heading
  - replaced "What You Lose" with Conflicts
  - set the report location rules
  - added severity examples
  - added the Cursor catalog version bump

## Sources and confidence

- **`project-tasks` (this repo):** the agent-profile fallback rule, at `plugins/project-tasks/skills/project-tasks/SKILL.md:71-86`. Read directly.
- **council-review (`ngmeyer`):** its five advisors and chairman synthesis inspired the merge step and the Conflicts section. Read through a WebFetch summary.
- **Florian `review-plan`:** four review axes. Read through a WebFetch summary. Its preference for DRY (don't repeat yourself) code is not adopted as a default.
- **`wrsmith108/plan-review-skill`:** severity ranking and approval before changes. Read through a WebFetch summary.
- **`serbanghita` plan critique:** feasibility and evidence checks. Read through a WebFetch summary.
- **`michaelbarton/dotfiles` PR #138:** the evidence and concern finding types, and reviewers starting with fresh context. Read through a WebFetch summary. The PR's state and exact wording are unverified.
- **Fluent-AI-Pod `plan-review` and microsoft `review-plan`:** not verified. The first returned no SKILL.md content. The second returned HTTP 403.
