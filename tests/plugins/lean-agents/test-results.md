# lean-agents Test Results

## 2026-07-29 — v0.0.55 (initial suite)

Scenario-based LLM evaluation, haiku subagents, reasoning-only (no tool use).
Three passes: bare rosters (A), OLD v0.0.54 guidance (B, the real RED), NEW v0.0.55 guidance (GREEN).

| Pass | Scenarios | Result |
|---|---|---|
| A — bare rosters | 1–7 | 7/7 reasonable; no baseline gap |
| B — OLD guidance | 1–7 | 7/7 reasonable; feared over-escalation did **not** reproduce |
| B — OLD guidance | 8 | Executed itself, but with unbounded `grep -rn` + temp-file spill |
| GREEN — NEW guidance | 1–7 | 7/7; guard rails (3, 4, 7) still escalate correctly |
| GREEN — NEW guidance | 8 | Executed itself with bounded, gitignore-aware `rg -n` |

**Status: PASS (narrowed claim).**

Measured improvement is search *hygiene* (scenario 8: `rg` over unbounded `grep -rn`, no temp
spill), plus removal of a documented self-contradiction. The suite **did not** demonstrate that
the change prevents spurious `full-executor` spawns — that behavior never appeared, even under
the old contradictory text. The CHANGELOG and PR description were worded to match.

**Defect caught and fixed by GREEN:** scenario 5 emitted `rg --include='*.js'` (`grep` syntax;
`rg` uses `-g`/`-t`). Guidance in `standard-executor.md` and `lean-executor.md` updated to call
this out explicitly.

**Follow-up:** re-run scenarios 1–7 against the final rule text (they ran against the draft that
predated the `rg -g` clarification). Scenario 8 already ran against final text.

Details: [`plugins/lean-agents/tests/baseline-results.md`](../../../plugins/lean-agents/tests/baseline-results.md),
[`plugins/lean-agents/tests/green-results.md`](../../../plugins/lean-agents/tests/green-results.md)
