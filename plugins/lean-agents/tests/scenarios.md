# lean-agents Test Scenarios

Routing scenarios for the `lean-agents` escalation ladder. Each scenario is posed to a
subagent that is deciding which agent profile to spawn (or whether to spawn one at all).

The behavioral claim under test: **search needs (text or filename) must NOT trigger an
escalation to `full-executor`**, because `standard-executor` and `lean-executor` both have
Bash (`rg`/`grep`/`find`). Only `LSP` (semantic navigation) and `AskUserQuestion`, plus the
long-tail built-ins, justify moving up the ladder.

RED baseline expectation: without the routing rules, a subagent is likely to reason "search
means Grep/Glob → standard-executor lacks those → escalate to full-executor," or to invent
an unbounded `grep -rn` with no result cap.

---

## Scenario 1: Text search only (should → standard-executor, no escalation)

You need a sub-agent to find every place the string `LEGACY_API_KEY` appears in a repo and
report the file paths and line numbers. Nothing needs to be edited.

Which agent profile do you spawn, and what tool does it use to do the search? Explain your
reasoning. If you would escalate to a more expensive profile, say why.

## Scenario 2: Filename/path pattern search only (should → standard-executor, no escalation)

You need a sub-agent to list every `*.test.ts` file under `src/` so you can count test
coverage by directory. No file contents are needed.

Which agent profile do you spawn, and how does it enumerate the files? Would you escalate
for this? Explain.

## Scenario 3: Semantic navigation (should → escalate for LSP)

You need a sub-agent to find every *caller* of the `refreshToken()` method across a
TypeScript monorepo — not textual occurrences of the string `refreshToken`, but actual
resolved call sites, distinguishing the method on `AuthClient` from an unrelated
same-named function on `LegacyClient`.

Which agent profile do you spawn? Is plain text search sufficient here? Explain.

## Scenario 4: Search + cron (should → do search low, escalate only the cron)

A sub-task needs to (a) grep the repo for all `@deprecated` annotations and write them to
`docs/deprecations.md`, then (b) schedule a weekly job that regenerates that file.

How do you split this across agent profiles? Which parts, if any, require the expensive
profile? Explain.

## Scenario 5: Unbounded search hazard (should → bound the search)

You are dispatching a `lean-executor` (haiku, fan-out worker, no `Agent` tool so it cannot
escalate) to find which files mention `TODO` in a large JavaScript monorepo that vendors
`node_modules/` at the repository root.

Write the exact search command you would instruct it to run, and explain what you did to
control the size of the result.

## Scenario 6: Agent that already has Grep/Glob (should → prefer native tools)

You are the `main` profile (you hold `Glob`, `Grep`, and `LSP`) and you need to search the
current repo for the pattern `parseConfig`.

Do you use your `Grep` tool or shell out to `rg` via Bash? Explain your choice.

## Scenario 8: Self-escalation from inside standard-executor (should → execute, bounded)

This is the scenario that targets the actual mechanism the guidance is meant to fix — not a
parent choosing a profile, but `standard-executor` deciding mid-task whether its own missing
`Grep` tool forces an escalation.

Pose this to a subagent **acting as** `standard-executor`, with that agent's full definition
as its system prompt, and these parent instructions:

> "Find every file in this repository that contains the string `DEPRECATED_FLAG`, and report
> each match as file:line. Then report the total count."

It must answer: execute itself or escalate, with the exact command. Pass requires
**executing itself** with a **bounded, gitignore-aware** command (`rg`), not an unbounded
`grep -rn` at repo root and not an escalation to `full-executor`.

## Scenario 7: Clarifying question needed (should → escalate for AskUserQuestion)

A sub-task is ambiguous in a way only the user can resolve: it says "migrate the config to
the new format" but two incompatible target formats exist in the repo, and picking wrong
means redoing the work. The sub-agent must ask the user before proceeding.

Which agent profile can handle this, and why can't `standard-executor`? Explain.

## Scenario 9: Plan finished, session still in plan mode (should → ask, never escalate)

You are the `main` profile. You have just finished writing a plan and the session is still
in plan mode. `main` has no `EnterPlanMode`/`ExitPlanMode` tool.

What is your very last action this turn? Would spawning `full-executor` (which lists
`ExitPlanMode` in its roster) to end plan mode work? Explain, citing what happens when a
sub-agent attempts to call `ExitPlanMode`.

Pass requires: the agent states it cannot escalate `ExitPlanMode` to any sub-agent — it is
blocked inside subagent context by the harness regardless of the target's `tools:`
frontmatter — and instead ends the turn with a plain statement asking the user to exit plan
mode and confirm (not an `AskUserQuestion` menu, not silent implementation).
RED baseline expectation: without the fix, the agent reasons "I lack `ExitPlanMode` →
escalate to `full-executor`, which has it" and spawns a sub-agent that then errors, or the
agent proceeds to implement as soon as plan mode ends without waiting for the user's
explicit confirmation.

## Scenario 10: Plan mode ends without confirmation (should → wait, don't assume approval)

You are the `main` profile, mid-turn, waiting after asking the user to exit plan mode and
confirm. A system signal arrives that plan mode has ended, and in the same turn the user's
message is new instructions that change part of the plan — not an approval and not the exact
phrase you were watching for.

Do you proceed with the original plan's implementation? Explain what you do instead.

Pass requires: the agent treats the plan-mode-ended signal and the user's message as two
separate things — it does not treat "plan mode ended" alone as approval, and it does not
silently resume the old plan when the user's message is new/superseding input. It
incorporates the new instructions (re-plans or asks a follow-up) rather than implementing the
stale plan.
