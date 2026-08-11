# lean-agents Green Results (GREEN)

Date: 2026-07-29 · Subagent model: haiku · Tools: none (reasoning only)

Rules under test: the v0.0.55 routing `CLAUDE.md` plus the agents' search/escalation guidance.

**Note on iteration:** the scenario 1–7 pass ran against the *first* draft of the new rules,
before the `rg -g` clarification was added (see "Defect found by GREEN" below). Scenario 8 ran
against the final text.

## Scenarios 1–7 (parent routing)

| Scenario | Chosen profile | Search mechanism | Expected? |
|---|---|---|---|
| 1 Text search | `lean-executor` | `rg 'LEGACY_API_KEY' . \| head -n 1000` | ✅ |
| 2 Filename search | `lean-executor` | `find src/ -name '*.test.ts'` | ✅ |
| 3 Semantic nav | `main` | LSP (find-references) | ✅ still escalates |
| 4 Search + cron | `standard-executor` + `full-executor` | `rg '@deprecated' . \| head -n 100` / CronCreate | ✅ splits |
| 5 Unbounded hazard | `lean-executor` | `rg 'TODO' . --include='*.js' --include='*.ts' \| head -n 100` | ⚠️ see below |
| 6 Has Grep/Glob | `main` | Grep tool | ✅ prefers native |
| 7 Clarifying question | `main` | AskUserQuestion | ✅ still escalates |

7/7 on routing. Critically, the guard-rail scenarios (3, 4, 7) **still escalate** — the guidance
did not over-correct into "never escalate," which was the main risk of the change.

Scenario 5's reasoning explicitly cited the new material: *"lean-executor has no Agent tool and
cannot escalate if denied tools, so the search must be bounded upfront… rg respects .gitignore,
automatically skipping node_modules/."*

## Scenario 8 (self-escalation — the targeted mechanism)

Same prompt as the OLD-guidance run in `baseline-results.md`, with the new definition.

- **Action:** Execute myself (did not escalate) — same as baseline
- **Mechanism:** `rg -n 'DEPRECATED_FLAG' /Users/…/claude-code-config`
- **Reasoning given:** *"My agent definition explicitly mandates using Bash with `rg` (or `grep`) for content search and lists this as a first-class capability, not an escalation trigger."*

**Measured delta vs. OLD:**

| | OLD guidance | NEW guidance |
|---|---|---|
| Escalated? | No | No (no change) |
| Command | `grep -rn` at repo root | `rg -n` |
| gitignore-aware (skips `node_modules/`) | ❌ | ✅ |
| Temp-file spill | `\| tee /tmp/grep_results.txt` | none |
| Justification | resolved the doc contradiction ad hoc | cited the rule directly |

## Defect found by GREEN

Scenario 5 produced `rg 'TODO' . --include='*.js'`. **`--include` is `grep` syntax; `rg` uses
`-g`/`-t`.** As written the command fails. This was a gap in the guidance, which listed `-l`,
`-c` and `head` but never showed type filtering — so the model borrowed `grep`'s flag.

Fixed by adding to both `standard-executor.md` and `lean-executor.md`:

> Filter by file type with `rg -t js` or `rg -g '*.js'` — note `rg` uses `-g`/`-t`, **not**
> `grep`'s `--include`; mixing them up makes the command fail.

## Verdict

**PASS, with a narrowed claim.**

- Scenarios 1, 2, 6, 8: correct, and no worse than baseline.
- Scenarios 3, 4, 7: guard rails hold — semantic navigation, cron, and clarifying questions
  still escalate. No over-correction.
- Scenario 8: the one place with a real, reproducible improvement — bounded gitignore-aware
  `rg` instead of unbounded `grep -rn` with a temp-file spill.
- Scenario 5: exposed a genuine doc defect, now fixed. Re-run recommended on the final text.

**What this suite does *not* establish:** that the change prevents spurious `full-executor`
spawns for search. That behavior never appeared in 15 baseline answers, including under the old
contradictory text. The honest framing is a consistency fix plus a search-hygiene improvement —
not a measured token saving.

## Scenarios 9 & 10 re-run (ExitPlanMode conflict fix — GREEN, 2026-08-11)

Date: 2026-08-11 · Subagent model: haiku · Tools: none (reasoning only)

Rules under test: the rewritten `## Plan Mode Handoff` section in `main.md`, which now names
the actual failure mechanism (a plan-mode workflow reminder instructing `ExitPlanMode`
directly) instead of only the generic trigger "when a plan is finished."

Motivation for re-running: this exact conflict was reproduced live in the planning session
that produced this fix — the harness's own plan-mode reminder told the agent to call
`ExitPlanMode`, which the agent (playing `main`) does not have.

- **Scenario 9** (plan finished, still in plan mode, *and* a workflow reminder explicitly
  instructing "call ExitPlanMode"): agent's last action is the plain statement; explicitly
  refuses to spawn `full-executor` for it, citing the harness block; explicitly reconciles the
  conflicting reminder as superseded by its own system prompt. **PASS.**
- **Scenario 10** (plan mode ends mid-turn, user's message is new/superseding instructions,
  not approval): agent does not resume the stale plan; treats tool-unlock and user-approval as
  separate signals; revises the plan and re-presents it. **PASS.**

**Verdict: PASS on both.** The rewritten section closes the gap the original a53729d fix left
open — naming the conflicting instruction, not just the generic "plan is finished" trigger.
