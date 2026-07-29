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
