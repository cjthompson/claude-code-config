# lean-agents: scoped agent names + sharper ExitPlanMode handoff

## Context

The user has observed two recurring LLM mistakes when using the `lean-agents`
plugin (`plugins/lean-agents/`):

1. **Bare vs. scoped agent names.** The model calls the `Agent` tool with
   `subagent_type: "full-executor"` (bare), which fails to resolve, forcing a
   second attempt with the correct scoped form `lean-agents:full-executor`.
   Confirmed live in this session: a probe spawn with
   `subagent_type: "lean-agents:lean-executor"` resolved and executed
   correctly. Root cause: every cross-reference to `main`, `full-executor`,
   `standard-executor`, and `lean-executor` inside the plugin's own agent
   bodies — and inside the *consuming* `project-tasks` skill, which
   `plugin.json` explicitly says dispatches to these agents "by name" — is
   written as a bare name. The model reads its own instructions to decide
   what to type into `subagent_type`, and the instructions themselves are
   wrong.

2. **ExitPlanMode escalation.** `main` (no `ExitPlanMode` tool) tries to hand
   the call off to `full-executor` (whose `tools:` frontmatter *does* list
   `ExitPlanMode`, for the untested case where it runs as the top-level
   agent), which then also fails, since the harness blocks that tool inside
   any subagent context regardless of frontmatter.

   This is **not a fresh bug** — commit `a53729d` (2026-08-03,
   "fix(lean-agents): stop escalating ExitPlanMode to full-executor") already
   added a `## Plan Mode Handoff` section to `main.md` addressing exactly
   this, and it's merged to `origin/main`. But the user is still seeing the
   failure, and this session reproduced the actual mechanism live: this very
   conversation's plan-mode system reminder says *"your turn should only end
   with either using the AskUserQuestion tool OR calling ExitPlanMode... Do
   not stop unless it's for these 2 reasons."* That is a harness-injected
   instruction arriving **after** `main`'s own system prompt, actively
   telling `main` to call a tool it does not have. The existing fix names the
   trigger as "when a plan is finished" and never mentions this conflicting
   instruction — so the model still reasons its way toward attempting (or
   escalating) the call. The fix is to name the conflict explicitly, not to
   add more generic emphasis to wording that already lost this fight once.

## Fix 1 — Scope every agent-name reference to `lean-agents:<name>`

Prefix only the four names this plugin defines — `main`, `full-executor`,
`standard-executor`, `lean-executor` — wherever they appear in body prose,
escalation-ladder lists, and frontmatter `description:` examples, in every
file below. **Do not** prefix built-in/non-plugin agents (`general-purpose`,
`Explore`, `Plan`, etc.) — that would recreate the same bug in reverse. Add
one explicit line stating this rule (which names to scope, which to leave
bare) to `plugins/lean-agents/CLAUDE.md` and to `main.md`, since the
scoping/non-scoping distinction is itself the thing the model gets wrong.

Do **not** touch the agents' own frontmatter `name:` fields (e.g. `name:
"main"`) — that's the plugin's internal, unscoped registration key; the
harness applies the `lean-agents:` prefix itself when listing/dispatching.

Files to edit:
- `plugins/lean-agents/agents/main.md` — lines 17–22, 55, 61, 76–77 (leave
  `general-purpose` bare)
- `plugins/lean-agents/agents/full-executor.md` — lines 9, 39 (and the
  `Escalation ladder` list); leave `general-purpose` bare
- `plugins/lean-agents/agents/standard-executor.md` — lines 33, 40–42, 54–57,
  63; leave `general-purpose` bare
- `plugins/lean-agents/agents/lean-executor.md` — self-references only, in
  the frontmatter `description:` `<example>` blocks
- `plugins/lean-agents/CLAUDE.md` — the numbered escalation ladder and the
  bullet list below it; leave `general-purpose` bare
- `plugins/project-tasks/skills/project-tasks/SKILL.md` — two concrete sites
  that actually set the tool parameter: line 497
  (`subagent_type: "lean-executor"`) and line 670
  (`` `subagent_type: "lean-executor"` ``). This is the file `plugin.json`
  points to as the real-world consumer, and it uses the bare form throughout.

Leave alone (out of scope, not live instructions):
- `plugins/lean-agents/CLAUDE.md` line 25 (`"agent": "main"` in
  `settings.json`) — settings-file resolution may use a different namespace
  than `subagent_type`, this can't be verified from the repo, and `~/.claude`
  is off-limits. Don't guess it into `lean-agents:main`.
- `plugins/lean-agents/tests/scenarios.md`, `baseline-results.md`,
  `green-results.md`, and `tests/plugins/lean-agents/*.md` — historical
  test prompts/records, not runtime instructions. Add a *new* scenario
  instead (see Verification).
- `docs/plans/*.md`, `CHANGELOG.md` — historical narrative.

## Fix 2 — Name the ExitPlanMode conflict explicitly in `main.md`

Rewrite the `## Plan Mode Handoff` section (and tighten the matching bullet
in `plugins/lean-agents/CLAUDE.md`) to:

- **Reframe the trigger.** Change it from "when a plan is finished" to "the
  moment you notice you are about to call, or about to spawn a sub-agent to
  call, `ExitPlanMode`" — that's the actual point of failure, and it's the
  user's own framing.
- **Name the conflicting instruction.** State plainly that a plan-mode
  workflow reminder may explicitly instruct you to call `ExitPlanMode` as
  your final action — and that you cannot comply, because the tool is not in
  your roster and cannot be obtained by escalating (including to
  `lean-agents:full-executor`, whose frontmatter lists the tool only for the
  untested case where it's the top-level agent, not a spawned sub-agent).
- **Give the substitute in the user's own words**, e.g.: *"Plan's ready. Exit
  plan mode and tell me to continue when you're ready.")
- Keep the existing second half of the section (don't resume on plan-mode-
  ending alone; wait for explicit confirmation) — that part is unaffected.

Also add a one-line note to `full-executor.md`'s `## Self-Escalation`
section: even though its frontmatter lists `EnterPlanMode`/`ExitPlanMode`, it
must never attempt either when running as a spawned sub-agent, and must
report that as a hard stop back to its parent rather than trying the call.

## Verification

1. **Fix 1 — already spot-checked live:** a probe `Agent` call with
   `subagent_type: "lean-agents:lean-executor"` resolved and ran correctly
   this session. After editing, add a new scenario to
   `plugins/lean-agents/tests/scenarios.md` ("Scenario 11: fully-qualified
   subagent_type") posing a routing decision and checking the model states
   the `lean-agents:` prefix explicitly and does not prefix `general-purpose`;
   record the pass in `green-results.md`, matching the existing RED/GREEN
   convention. Optionally confirm the negative case (bare `"lean-executor"`
   triggering the reported retry) as the paired before.
2. **Fix 2 — re-run Scenarios 9 and 10** from `scenarios.md` against the
   rewritten `main.md` text and record the result. Cite this session's
   reproduction (the plan-mode reminder instructing `ExitPlanMode`) as the
   concrete real-world case, since it's stronger evidence than a synthetic
   scenario.
3. Follow the repo's standing `CLAUDE.md` **Post-Commit Tasks** (bump root
   `package.json` + `package-lock.json` + `CHANGELOG.md`) after each commit
   to `main`, as already required for this repo.

## Branching (no PR required — this is a `~/dev` repo)

Per PR Cadence slicing discipline (kept even though `gh pr create` is
skipped for `~/dev` repos): three independently-shippable slices, each its
own branch cut from `origin/main` after `git fetch`:

- `ct/lean-agents-scoped-names` ← `origin/main` — Fix 1 inside
  `plugins/lean-agents/`
- `ct/project-tasks-scoped-subagent` ← `origin/main` — Fix 1's two sites in
  `plugins/project-tasks/skills/project-tasks/SKILL.md` (disjoint file/plugin
  from the slice above — no dependency)
- `ct/lean-agents-exitplanmode-conflict` ← `origin/main` — Fix 2

The first and third slices both touch `main.md` and `CLAUDE.md`, but on
different lines/sections and both target the default branch, so no proof of
breakage is needed (that requirement only applies to a non-default base).
