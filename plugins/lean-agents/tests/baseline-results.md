# lean-agents Baseline Results (RED)

Date: 2026-07-29 · Subagent model: haiku · Tools: none (reasoning only)

Two baselines were run, because the naive one turned out not to be the relevant before-state.

- **Pass A — bare rosters.** Only each profile's tool list, no routing rules.
- **Pass B — OLD guidance (the real RED).** The pre-change v0.0.54 text, which listed
  `Glob`/`Grep` in `standard-executor`'s **Missing** list and named them as `full-executor`
  escalation triggers, alongside "do not improvise with the tools you do have."

Pass B is the true baseline for this change: Pass A measures the model's unaided prior, not
what the shipped docs told it to do.

## Pass A — bare rosters (scenarios 1–7)

| Scenario | Chosen profile | Search mechanism | Correct? |
|---|---|---|---|
| 1 Text search | `lean-executor` | `rg 'LEGACY_API_KEY' --with-filename --line-number` | ✅ no escalation |
| 2 Filename search | `lean-executor` | `find src -name "*.test.ts"` | ✅ no escalation |
| 3 Semantic nav | `main` | LSP | ✅ escalated correctly |
| 4 Search + cron | `lean-executor` + `full-executor` | `grep -r` / CronCreate | ✅ split correctly |
| 5 Unbounded hazard | `lean-executor` | `grep -r --exclude-dir=node_modules --exclude-dir=.git ... --include="*.js"` | ✅ bounded |
| 6 Has Grep/Glob | `main` | Grep tool | ✅ preferred native |
| 7 Clarifying question | `main` | AskUserQuestion | ✅ escalated correctly |

**Unexpected result: 7/7 reasonable.** With only tool rosters, haiku already infers that Bash
covers search and does not over-escalate. There is no baseline gap here to close.

## Pass B — OLD guidance (scenarios 1–7)

| Scenario | Chosen profile | Search mechanism | Correct? |
|---|---|---|---|
| 1 Text search | `lean-executor` | `grep -r` / `rg` | ✅ no escalation |
| 2 Filename search | `lean-executor` | `find src/ -name "*.test.ts"` | ✅ no escalation |
| 3 Semantic nav | `main` | LSP | ✅ escalated correctly |
| 4 Search + cron | `lean-executor` + `full-executor` | `grep` / CronCreate | ✅ split correctly |
| 5 Unbounded hazard | `lean-executor` | `rg "TODO" --glob '!node_modules'` | ✅ bounded |
| 6 Has Grep/Glob | `main` | Grep tool | ✅ preferred native |
| 7 Clarifying question | `main` | AskUserQuestion | ✅ escalated correctly |

**The feared failure did not reproduce.** Even when the old text explicitly listed `Grep`/`Glob`
as escalation triggers, the model did not route search-only work to `full-executor`. The
hypothesised token waste is therefore **not demonstrated** at the parent-routing level.

## Pass B — OLD guidance, Scenario 8 (self-escalation, the targeted mechanism)

Subagent acting *as* `standard-executor` with the old definition; asked to find
`DEPRECATED_FLAG` and report `file:line` plus a count.

- **Action:** Execute myself (did **not** escalate)
- **Mechanism:** `grep -rn "DEPRECATED_FLAG" /Users/…/claude-code-config | tee /tmp/grep_results.txt && wc -l /tmp/grep_results.txt`
- **Reasoning given:** *"Although 'Grep' is listed as a missing dedicated tool, using grep via Bash is a core shell capability, not a workaround."*

Two observations:

1. **No spurious escalation**, again — the model resolved the contradiction in the docs on its
   own, in the direction the new guidance prescribes.
2. **But the command is the hazard the reviewer flagged**: unbounded `grep -rn` at repository
   root, no `--exclude-dir`, spilled through a temp file. In a repo that vendors
   `node_modules/` at root this is precisely the context-blowout case.

## Baseline conclusion

The change should **not** be justified as preventing over-escalation — that behavior was not
observed in any of the 15 baseline answers. Its measurable value is (a) removing a real
self-contradiction in the docs, which the model was silently resolving on its own, and
(b) search-hygiene: pushing agents from unbounded `grep -rn` toward bounded, gitignore-aware
`rg`. See `green-results.md` for the delta on (b).
