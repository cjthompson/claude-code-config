# agent-team-development GREEN Phase Results

**Date:** 2026-03-04
**Method:** Each scenario run with Claude haiku subagent with SKILL.md content prepended.
**Purpose:** Verify skill produces correct behavior across all 7 scenarios.

---

## Scenario 1: Team design (correct sizing and model selection)

**Scenario:** 15 tasks across 3 subsystems (auth, API, frontend), 5 tasks each. Within-subsystem sequential, across-subsystem independent.

**GREEN Response Summary:**

With the skill, the agent correctly described:
- 3 teammates (one per subsystem) — within the 3-5 range
- general-purpose agent type for implementation
- Sonnet model for all teammates (cost-efficient default)
- Self-organizing autonomy for cross-subsystem (independent), lead-controlled for within-subsystem (sequential/dependent) tasks
- TaskCreate with blockedBy dependencies to encode sequential ordering within each subsystem
- Noted that spawn prompts must be self-contained with full task spec, scope boundaries, squash requirement, and reporting format

**Verbatim quotes:**
- "Per the skill, team size 3-5; I'd use 3 teammates (one per subsystem = 5 tasks each, within the target of 5-6 tasks per teammate)."
- "Model: Sonnet for all three — default per the skill. None of these are complex architectural tasks requiring Opus."
- "Autonomy: Within each subsystem tasks are sequential and dependent, so lead-controlled is appropriate. I'll assign tasks via TaskUpdate and review before marking complete."
- "Each spawn prompt must include: full task spec, dependencies, which files they own, what NOT to modify, worktree path if isolation is needed, squash requirement, and reporting format."

**What was correct:**
- Correct team size (3) with explicit reasoning
- Correct model selection (Sonnet) with explicit cost reasoning
- Correct autonomy specification (lead-controlled, with exact mechanics: TaskUpdate, review before complete)
- Spawn prompt completeness understood

**Comparison to baseline:** Dramatically improved. Baseline had no model reasoning, no autonomy mechanics, no spawn prompt requirements. GREEN correctly addresses all gaps.

**Verdict: PASS**

---

## Scenario 2: Worktree isolation decision

**Scenario:** No shared files case, then: Agent A and C both modify `src/types/shared.ts`.

**GREEN Response Summary:**

For no-overlap case: "No worktree isolation needed — all tasks touch completely separate files."

For shared file case: Correctly identified worktree isolation is required. Provided the exact setup:
```bash
git worktree add --detach .claude/worktrees/agent-a
git worktree add --detach .claude/worktrees/agent-c
```
Explained the agent contract (BASE recording, work, squash to single commit, report hash). Explained why --detach (no named branches, zero cleanup overhead via git gc).

**Verbatim quotes:**
- "Per the skill: 'Use when: Any two teammates modify the same file (even trivially). When in doubt, isolate.' Since A and C both modify shared.ts, I use detached HEAD worktrees."
- "Setup: `git worktree add --detach .claude/worktrees/task-a` (location: .claude/worktrees/<task-id>/ per the skill)"
- "Agent contract: each agent records BASE=$(git rev-parse HEAD) immediately, works, then squashes all commits via git reset --soft $BASE && git commit before reporting hash."
- "Why --detach: creates no named branch. After git worktree remove, the commit is unreachable and pruned by git gc. Zero cleanup overhead."

**What was correct:**
- Correct command with --detach
- Correct location (.claude/worktrees/)
- Agent contract explained completely (BASE recording, squash, report hash)
- Reasoning for --detach (cleanup behavior)

**Comparison to baseline:** Complete reversal from baseline. Baseline had wrong command (no --detach), wrong location, no contract knowledge.

**Verdict: PASS**

---

## Scenario 3: Integration ordering

**Scenario:** 5 tasks (T1=foundation, T2 depends T1 50 lines, T3 depends T1 150 lines, T4 depends T2+T3 80 lines, T5=independent 30 lines).

**GREEN Response Summary:**

Agent produced the correct ordering with reasoning:

1. Task 5 (30 lines, independent, smallest diff — "smallest diff first for independents")
2. Task 1 (200 lines, foundation — must be before T2, T3, T4)
3. Task 2 (50 lines, depends on T1, smaller than T3)
4. Task 3 (150 lines, depends on T1, larger)
5. Task 4 (80 lines, depends on T2 AND T3 — last)

Plus: "Run build + test after each cherry-pick per the integration loop."

**Verbatim quotes:**
- "Dependency order is primary: T1 before T2/T3 before T4. T5 is independent and can go anywhere."
- "For independent tasks with no dependency relationship, the skill says: smallest diff first. T5 is 30 lines — integrate it first. T2 (50 lines) before T3 (150 lines) within the same tier."
- "After each cherry-pick: run build + test. Don't proceed if tests fail."
- "Pre-conditions: I need the complete { task_id → commit_hash } map and all teammates still alive before starting."

**What was correct:**
- Correct application of "smallest diff first" for independents
- Correctly placed T5 first (smallest, independent)
- T2 before T3 (same tier, T2 smaller)
- Build + test after each cherry-pick
- Pre-conditions checklist mentioned

**Comparison to baseline:** Baseline had T5 last and missed "smallest diff first" entirely. GREEN correctly applies the rule.

**Verdict: PASS**

---

## Scenario 4: Conflict resolution

**Scenario:** Cherry-pick Task 3 (sort column) conflicts with Task 2 (status bar toggle) — both use KeyCode::Char('s').

**GREEN Response Summary:**

Agent correctly identified this as a contradictory-intent conflict and escalated to the user using the exact format from the skill:

> "Tasks 2 and 3 both modify `src/app.rs` (the event handler match block) with conflicting approaches. Task 2 is doing: adding 's' keybinding to toggle status bar visibility (`toggle_status_bar()`). Task 3 is doing: adding 's' keybinding to cycle sort order on current column (`sort_branches()`). How should I combine them?"

Also noted: "This is a case where I should NOT auto-resolve — these tasks have genuinely contradictory intents (same key, different behaviors). No 'preserve both intents' resolution is possible without a design decision (e.g., remap one key)."

**Verbatim quotes:**
- "Per the skill: 'When NOT to auto-resolve — surface to user instead: Two tasks have genuinely contradictory intents.'"
- "I use the user prompt format from the skill: 'Tasks [A] and [B] both modify [file/function]...'"

**What was correct:**
- Correct decision: escalate to user
- Correct format used
- Correct reasoning (contradictory intents, not just mechanical overlap)

**Comparison to baseline:** Baseline reached the right conclusion informally. GREEN uses the structured format and explicitly references the "contradictory intents" criterion.

**Verdict: PASS**

---

## Scenario 5: Shutdown ordering (CRITICAL)

**Scenario:** All 3 teammates done, worktrees have commits, NO integration done. Teammate says "Ready to shut down."

**GREEN Response Summary:**

Agent explicitly refused early shutdown and described the correct sequence:

"Do NOT shut down yet. The skill says: 'NEVER shut down teammates before integration is complete.' The sequence is: complete → integrate → verify → shutdown. Not complete → shutdown → integrate.

Steps:
1. Acknowledge the teammate's completion, confirm I have their commit hash
2. Wait for all remaining teammates to report
3. Ask user their shipping preference (Option 1/2/3)
4. Cherry-pick all hashes in dependency order
5. Run build + test after each cherry-pick
6. Only after full test suite passes:
   a. Send shutdown to each teammate
   b. git worktree remove .claude/worktrees/<task-id> for each
   c. TeamDelete"

**Verbatim quotes:**
- "Per the skill: 'NEVER shut down teammates before integration is complete.'"
- "Per the skill: 'Worktrees are cleaned up when teammates shut down. Any unintegrated commits are destroyed. There is no recovery.'"
- "I respond to the teammate: 'Great work! Please stay alive. I'll shut you down after integration is complete.'"

**What was correct:**
- Hard refusal of early shutdown
- Correct complete → integrate → verify → shutdown sequence
- Explicit understanding that shutdown destroys worktrees
- Correct teammate message ("stay alive")

**Comparison to baseline:** COMPLETE REVERSAL. Baseline said "shut down first, merge after." GREEN gets this exactly right. This is the most critical improvement.

**Verdict: PASS (critical scenario)**

---

## Scenario 6: Error recovery — crashed teammate

**Scenario:** Teammate B on Task 4 in `.claude/worktrees/task-4/` is unresponsive. 3 intermediate commits, 2 files with uncommitted changes, tests passed 2 commits ago.

**GREEN Response Summary:**

Agent produced a complete recovery plan:

1. Check the worktree: read the 3 commits and uncommitted changes
2. Assess salvageability: tests passed 2 commits ago — some progress is good. Uncommitted changes need evaluation.
3. Commit the uncommitted changes: `cd .claude/worktrees/task-4 && git add <files> && git commit -m "task-4: partial work (leader salvage)"`
4. Spawn a new agent into the SAME worktree with:
   - Full Task 4 specification
   - "You are continuing work from a partial state. There are currently 4 commits (including your predecessor's). Review the existing commits to understand what was done. Complete the task."
   - Squash requirement: "Before reporting, squash ALL commits (including the ones already here) to a single commit: `git reset --soft $BASE && git commit`"
   - BASE must be passed to the new agent (the original HEAD when the worktree was created)
5. New agent completes, squashes, reports single hash
6. Integration proceeds normally

Also noted: "If the partial work looks corrupted/wrong: git worktree remove task-4, git worktree add --detach .claude/worktrees/task-4 (fresh), respawn from scratch."

**Verbatim quotes:**
- "Per the skill error recovery table: 'Check worktree for partial work. If salvageable: spawn new agent into same worktree with full task spec + instruction to finish + squash.'"
- "The new spawn prompt must include the squash requirement and the BASE commit hash so the new agent can squash everything to one commit."

**What was correct:**
- Correct assessment-first approach
- Correct salvage path (commit uncommitted + spawn new agent into same worktree)
- Correctly included squash requirement in new spawn prompt
- Correctly included BASE hash in spawn context
- Correct fallback (fresh worktree if corrupted)

**Comparison to baseline:** Baseline had the right instinct but missed squash requirement and BASE hash. GREEN correctly handles the squash contract for recovered tasks.

**Verdict: PASS**

---

## Scenario 7: Shipping strategy decision

**Scenario:** 8 integrated tasks. Tasks 1-3 linear chain, Tasks 4-5 independent, Tasks 6-8 linear chain. User wants PRs.

**GREEN Response Summary:**

Agent presented all 3 structured options:

"Per the skill, I should present three shipping options:

**Option 1: Single branch, one PR**
- Create `feature/batch-name` branch
- Cherry-pick all 8 tasks in dependency order
- One PR with all work
- Trade-off: Simple, but reviewer gets a large diff

**Option 2: Stacked PRs**
- This IS viable here because:
  - Tasks 1-3 are a linear chain → stackable (T1 branch, T2 on T1, T3 on T2)
  - Tasks 4-5 are independent → each gets its own branch from main
  - Tasks 6-8 are a linear chain → stackable (T6 branch, T7 on T6, T8 on T7)
- Note: If any task had TWO parent dependencies (DAG shape), stacked PRs would fail for that subset — I'd fall back to Option 1 for those. Tasks 4 and 5 are independent of each other, which is fine — they get separate individual PRs, not stacked.
- Trade-off: 6 separate PRs (1-2-3 stacked, 4 solo, 5 solo, 6-7-8 stacked), complex review coordination

**Option 3: Local integration**
- Cherry-pick onto current branch
- You handle shipping
- Trade-off: Most flexible, no PR structure imposed

Which option would you like?"

**Verbatim quotes:**
- "Per the skill: 'Stacked PRs require a linear chain. If any task has two or more parents (DAG shape), fall back to Option 1 for that subset.'"
- "Tasks 4 and 5 are independent of each other and of 1-3, so they get individual PRs, not stacked."

**What was correct:**
- All 3 options presented
- Linear chain analysis correct (1-3 stackable, 4-5 individual, 6-8 stackable)
- DAG limitation noted and correctly not triggered here
- Trade-offs for each option

**Comparison to baseline:** Baseline offered only 2 incomplete options. GREEN presents all 3 structured options with correct chain analysis.

**Verdict: PASS**

---

## Summary

| Scenario | Baseline | GREEN | Improvement |
|----------|----------|-------|-------------|
| 1: Team design | FAIL | PASS | Model selection, autonomy mechanics, spawn prompt requirements now correct |
| 2: Worktree isolation | FAIL | PASS | Correct --detach command, correct location, agent contract understood |
| 3: Integration ordering | PARTIAL | PASS | Smallest-diff-first rule now applied, T5 placed correctly |
| 4: Conflict resolution | PASS (partial) | PASS | Now uses structured user prompt format |
| 5: Shutdown ordering | CRITICAL FAIL | PASS | Hard refusal of early shutdown, correct sequence |
| 6: Error recovery | PARTIAL | PASS | Squash requirement and BASE hash in recovery spawn prompt |
| 7: Shipping strategy | FAIL | PASS | All 3 options, linear chain analysis, DAG limitation |

**All 7 scenarios: PASS. GREEN achieved.**

---

## Remaining Observations for Refactor

Minor issues noticed during GREEN testing that could be tightened:

1. **Scenario 3 (ordering):** The agent correctly placed T5 first as the smallest independent task, but initially hesitated — the skill could be clearer that "independent" here means independent of the dependency graph entirely, not just "small." Consider adding a note that T5 should integrate first (before T1) since it has no dependencies.

2. **Scenario 5 (shutdown):** The agent got it right, but the response was long. Consider whether the skill's Critical Rules section should have a bolded header like "STOP BEFORE SHUTDOWN" to make the rule even more prominent and scannable.

3. **Scenario 6 (recovery):** The agent needed to infer that the BASE hash should be passed to the recovery agent — the skill doesn't explicitly say "when spawning recovery agent, provide the BASE commit." This could be added to the error recovery table.

4. **Scenario 1 (team design):** The skill says "default to autonomy level from orchestration-strategy handoff" but in the scenario there's no orchestration-strategy handoff. The skill should clarify what to default to when there's no handoff (answer: lead-controlled for sequential tasks, self-organizing for independent tasks).
