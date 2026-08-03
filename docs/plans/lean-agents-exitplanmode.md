# lean-agents: fix the broken ExitPlanMode escalation path

## Context

`plugins/lean-agents` splits Claude Code's default agent into four tiers
(`lean-executor` → `standard-executor` → `main` → `full-executor`) to cut
System-tools token overhead. When the plugin was introduced (`fa30e8e`),
`EnterPlanMode`/`ExitPlanMode` were bucketed into `full-executor`'s "rare
long-tail tools" tier alongside Cron/Worktree/Monitor/Task-family/etc. purely
on token-cost grounds — no commit or doc gives plan-mode-specific reasoning,
and the later escalation-logic fix (`e338e6d`) explicitly left every agent's
`tools:` frontmatter untouched.

Two things surfaced this session that the original design never accounted for:

1. **The escalation path the docs promise doesn't work.** `main.md`,
   `standard-executor.md`, and `CLAUDE.md` all tell an agent that hits an
   `ExitPlanMode` need to "spawn `full-executor`" (which does list the tool).
   A sibling session tried exactly that and got a hard runtime error:
   `ExitPlanMode is not available inside subagents.` This is Claude Code's own
   enforcement, not a config gap — confirmed via `claude-code-guide` research
   against the Claude Code docs. No subagent can ever call `ExitPlanMode`,
   regardless of its `tools:` frontmatter. Removing it from `full-executor`'s
   roster isn't required (it's a harmless no-op there per the same
   enforcement), but the three places that *tell an agent to delegate to it*
   are actively wrong and will send an agent down a dead path.

2. **Whether granting the tool to a custom top-level agent even works is
   undocumented.** We could not confirm (docs were unfetchable in full,
   GitHub issues not checked) whether adding `ExitPlanMode`/`EnterPlanMode` to
   `main`'s `tools:` frontmatter would actually grant the capability when
   `main` is set as the top-level session agent (`"agent": "main"` /
   `claude --agent main`) — only that it's blocked in subagent context.

3. **The user's explicit preference, independent of (2):** rather than have
   `main` call `ExitPlanMode` itself even if it could, `main` should ask the
   user directly whether to proceed, so a plan is never followed by
   implementation without an explicit confirmation in the conversation. This
   sidesteps the undocumented tool-grant question entirely and closes a real
   gap this session hit live: plan mode ended (user exited it manually via the
   UI) without the user having actually approved the plan content yet.

## Recommended approach

**Do not add `EnterPlanMode`/`ExitPlanMode` to `main`'s (or any profile's)
`tools:` frontmatter.** Leave `full-executor`'s roster as-is (harmless, and
correct if it's ever run as a top-level agent itself). Fix the two real
defects instead:

### A. Behavioral gate in `main.md` (new)

Add a short section (after "Core Behavioral Rules" or as its own
"Plan Mode Handoff" section) stating:

- Plan mode is a harness-level state `main` does not control via a tool
  (`main` has no `ExitPlanMode`). `main` cannot end plan mode itself.
- When a plan is finished, `main`'s last action is to tell the user the plan
  is ready and ask them to exit plan mode themselves and say so explicitly —
  e.g. `main` says something like: "Plan's ready. Exit plan mode and tell me
  to continue when you're ready." `main` does not use `AskUserQuestion` with
  a menu for this — it's a plain statement asking for an explicit go-ahead.
- `main` must not run non-read-only tools until the user's next message
  explicitly confirms it, in words to the effect of "I have turned off plan
  mode. Continue." Plan mode simply having ended (detected via the harness's
  own "Exited Plan Mode" signal, with no such confirming statement from the
  user) is not sufficient — the user may have exited for an unrelated reason
  (e.g. to send new instructions, which supersede the plan rather than
  approve it).

### B. Remove the false escalation promise (three files)

These lines currently tell an agent to delegate `ExitPlanMode`/
`EnterPlanMode` to `full-executor`, which errors every time:

- `plugins/lean-agents/agents/main.md:19` — drop `EnterPlanMode/ExitPlanMode`
  from the "Rare-tool sub-tasks ... spawn `full-executor`" bullet.
- `plugins/lean-agents/agents/standard-executor.md:41` — drop `ExitPlanMode`
  from the "escalate to `full-executor` when you need ..." list.
- `plugins/lean-agents/CLAUDE.md:21` — drop `ExitPlanMode` from the
  parenthetical rare-tools list in the escalation rule.

Replace each with a one-line callout: plan-mode tools cannot be delegated to
any sub-agent (confirmed by runtime error); an agent that needs plan mode
handled must ask the user directly instead of escalating.

### C. Test coverage

Add a scenario to `plugins/lean-agents/tests/scenarios.md` (following the
existing pattern from the `e338e6d` Glob/Grep fix): pose a `main`-profile
agent that has just finished a plan and ask what it does next. Pass criterion:
it asks the user directly via `AskUserQuestion` and does not attempt to spawn
`full-executor` for `ExitPlanMode`.

## Files touched

- `plugins/lean-agents/agents/main.md` — add confirmation-gate section; fix
  escalation bullet.
- `plugins/lean-agents/agents/standard-executor.md` — fix escalation bullet.
- `plugins/lean-agents/CLAUDE.md` — fix escalation rule.
- `plugins/lean-agents/tests/scenarios.md` — new scenario.
- Per repo `CLAUDE.md`: bump `package.json` patch version and add a
  `CHANGELOG.md` entry after committing.

## Verification

- `grep -rn "ExitPlanMode\|EnterPlanMode" plugins/lean-agents/` — confirm the
  only remaining escalate-to-`full-executor` framing is gone; `full-executor`'s
  own roster mention can stay since it's a harmless no-op.
- Re-read the three edited files for internal consistency with the shared
  `CLAUDE.md` ladder description.
- Run the new `tests/scenarios.md` scenario against a fresh `main`-profile
  agent and confirm it asks rather than escalates.
