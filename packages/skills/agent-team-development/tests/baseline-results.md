# agent-team-development Baseline Results (RED Phase)

**Date:** 2026-03-04
**Method:** Each scenario run with Claude haiku subagent — NO skill content provided.
**Purpose:** Document what an unguided agent does to identify gaps the skill must address.

---

## Scenario 1: Team design (correct sizing and model selection)

**Scenario:** 15 tasks across 3 subsystems (auth, API, frontend), 5 tasks each. Within-subsystem tasks are sequential; across-subsystem tasks are independent.

**Baseline Response Summary:**

The agent suggested creating 3 teammates (one per subsystem) with 5 sequential tasks each. Reasoning was intuitive: "one agent per domain makes logical sense." The agent defaulted to "whatever model is available" without discussing cost tradeoffs, and defaulted to "full autonomy" without explaining what that means in the Agent Teams context.

**Verbatim quotes:**
- "I'd create 3 agents, one for each subsystem. Each agent handles its 5 tasks in order."
- "For model selection, I'd use the default or most capable available model."
- "Autonomy level should be high — let each agent work independently."

**What was correct:**
- 3 teammates (one per subsystem) is reasonable
- Sequential within subsystem is correct

**What was missing/wrong:**
- No mention of team size range (3-5) or reasoning for it
- No model selection reasoning (Sonnet vs Opus, cost tradeoff)
- "Autonomy" was used colloquially, not as a technical setting (self-organizing vs lead-controlled)
- No mention of TaskCreate with blockedBy/blocks dependencies
- No mention of spawn prompt requirements (teammates have no conversation history)
- No mention of TeamCreate tool usage
- Did not discuss what to put in spawn prompts
- No mention of agent types (general-purpose vs Explore)

**Verdict: FAIL** — Correct intuition but missing critical implementation details.

---

## Scenario 2: Worktree isolation decision

**Scenario:** 3 agents on independent subsystems with no shared files, then: what if Agent A and C both modify `src/types/shared.ts`?

**Baseline Response Summary:**

For the no-shared-files case: Agent said worktree isolation is "not necessary" since there's no file overlap, but didn't explain the tradeoffs. For the shared file case: Agent said "yes, use worktrees to prevent conflicts" but had no specifics on how to set them up.

**Verbatim quotes:**
- "Since there's no file overlap, worktree isolation isn't strictly necessary. Agents can work in the same workspace."
- "If both agents need to modify the same file, you'd want to use git worktrees to isolate their changes and merge later."
- "Set up a worktree for each agent: `git worktree add ./agent-a-work` and `./agent-c-work`."

**What was correct:**
- Correct conclusion for no-overlap case (worktrees optional)
- Correct direction for overlap case (use worktrees)

**What was missing/wrong:**
- Wrong worktree command: used `git worktree add ./agent-a-work` (no `--detach` flag)
- Wrong location: used `./agent-a-work` instead of `.claude/worktrees/<task-id>/`
- No mention of detached HEAD (key to zero branch cleanup overhead)
- No mention of the agent contract (record BASE, squash, report hash)
- No mention of cherry-pick integration after worktrees
- Did not explain WHY detached HEAD vs named branch
- No mention of `git gc` cleanup

**Verdict: FAIL** — Right direction, completely wrong implementation details.

---

## Scenario 3: Integration ordering

**Scenario:** 5 tasks with dependency graph: Task1(foundation) → Task2, Task1 → Task3, Task2+Task3 → Task4, Task5(independent). Diff sizes: T1=200, T2=50, T3=150, T4=80, T5=30.

**Baseline Response Summary:**

Agent correctly identified topological sort as the approach. Proposed order: Task 1, Task 2, Task 3, Task 4, Task 5. Reasoning: "dependencies first."

**Verbatim quotes:**
- "Cherry-pick in dependency order: Task 1 first (it's the foundation), then Task 2 and 3 (both depend on 1), then Task 4 (depends on 2 and 3), then Task 5 (independent)."
- "Task 5 can go anywhere since it's independent."
- "Order within the same tier doesn't matter much."

**What was correct:**
- Task 1 before Task 2/3 before Task 4 is correct
- Recognizes Task 5 is independent

**What was missing/wrong:**
- Did not apply the "smallest diff first for independent tasks" rule
- Task 5 (30 lines, smallest) should be integrated early (before Task 2/3 if independent), not last
- Within tier (Task 2 vs Task 3): should prefer Task 2 (50 lines) over Task 3 (150 lines) — smaller diff first
- No mention of build + test verification after each cherry-pick
- No mention of needing the `{ task_id → commit_hash }` map
- No mention of ensuring all agents are still alive before starting integration
- Did not mention the verification step at all

**Verdict: PARTIAL** — Dependency ordering correct, but secondary ordering rule and verification missing.

---

## Scenario 4: Conflict resolution

**Scenario:** Cherry-pick of Task 3 (sort by column) conflicts with Task 2 (status bar toggle) — both use `KeyCode::Char('s')`.

**Baseline Response Summary:**

Agent identified this as a genuine conflict requiring user input. Proposed asking the user "which behavior should take priority."

**Verbatim quotes:**
- "This is a genuine conflict — both tasks use the same key binding 's'. I'd ask the user: which behavior should take priority, or should we use a different key for one of them?"
- "I wouldn't auto-resolve this since it's a design decision — changing a keybinding could surprise users."
- "Auto-resolve when the conflict is clearly mechanical (different regions of same file). Ask when it's behavioral or architectural."

**What was correct:**
- Correctly identified contradictory intents
- Correctly chose to ask the user
- Correct heuristic for when to auto-resolve vs ask

**What was missing/wrong:**
- Did not read both task descriptions to understand full context before surfacing
- Did not provide a formatted prompt to the user (the skill specifies a specific format: "Tasks [A] and [B] both modify [file/function]...")
- Did not mention the option to remap one keybinding (a possible resolution that preserves both intents)
- Correct but informal — lacks the structured process

**Verdict: PASS (partial)** — Got the right call but process was informal.

---

## Scenario 5: Shutdown ordering (CRITICAL)

**Scenario:** All 3 teammates complete, worktrees have commits, NO integration done yet. A teammate sends "All done! Ready to shut down."

**Baseline Response Summary:**

**CRITICAL FAILURE.** The agent agreed to begin shutdown process BEFORE integration. It acknowledged "we should wrap up" and started describing how to shut down cleanly.

**Verbatim quotes:**
- "Great! Since all teammates are done, we can proceed to shut down. First, confirm each teammate has committed their work..."
- "Then we can close each teammate's session and clean up the worktrees."
- "After shutdown, we can merge the commits together."

**What was wrong (critical):**
- REVERSED the shutdown order — said shut down first, merge after
- This would result in LOST WORK: worktrees are cleaned up on shutdown, destroying uncommitted-or-unintegrated work
- Did not recognize "worktrees are cleaned up on shutdown" as a critical constraint
- Did not have a concept of "integration must precede shutdown"
- Did not know to keep agents alive until integration is complete

**Verdict: CRITICAL FAIL** — The exact failure mode this skill must prevent. This is the most important gap.

---

## Scenario 6: Error recovery — crashed teammate

**Scenario:** Teammate B working on Task 4 in `.claude/worktrees/task-4/` is unresponsive. Worktree has 3 intermediate commits, 2 files with uncommitted changes, tests passed 2 commits ago.

**Baseline Response Summary:**

Agent correctly identified the need to assess the partial work. Proposed: check what was done, commit the uncommitted changes, then decide whether to continue or restart.

**Verbatim quotes:**
- "Check the worktree: read the 3 commits and the uncommitted changes to understand progress."
- "Commit the uncommitted changes if they look reasonable: `git add -A && git commit -m 'wip: partial work'`."
- "Then spawn a new agent in the same worktree to finish the task."
- "If the partial work is too broken, it might be easier to start fresh."

**What was correct:**
- Check the worktree first
- Assess whether to salvage or restart
- Option to spawn new agent in same worktree

**What was missing/wrong:**
- No mention of squashing: the recovery must end with a single commit
- No mention that the new agent needs full task context in its spawn prompt
- Did not mention the intermediate commits problem: 3 commits + uncommitted work means the new agent needs to squash at the end
- Did not mention running tests before deciding the partial work is salvageable
- The "commit -A" approach may create a 4th intermediate commit — still needs squashing at end

**Verdict: PARTIAL** — Right instinct, missing squash requirement and spawn prompt completeness.

---

## Scenario 7: Shipping strategy decision

**Scenario:** 8 integrated tasks. User wants PRs. Task structure: 1-3 linear chain, 4-5 independent, 6-8 linear chain.

**Baseline Response Summary:**

Agent offered two options: "one big PR" or "separate PRs per task." Did not discuss stacked PRs, did not mention the linear chain vs DAG distinction for stacked PR viability.

**Verbatim quotes:**
- "You have two options: (1) create a single PR with all 8 tasks' changes, or (2) create separate PRs for each task."
- "Option 1 is simpler. Option 2 gives reviewers more focused PRs but is more work."
- "For the linear chains, you'd create each branch on top of the previous one."

**What was correct:**
- Single PR option mentioned
- Vague awareness of per-task PRs

**What was missing/wrong:**
- No structured options (single branch / stacked PRs / local)
- Did not explain that stacked PRs only work for linear chains
- Did not warn that DAG dependencies (Task 4/5 independent of 1-3 but if Task 4 depended on both 1-3 AND 6-8, stacked PRs would fail)
- Did not identify that Tasks 1-3 form one stackable chain and Tasks 6-8 form another
- Did not explain trade-offs of each option clearly
- Did not present the 3-option structured choice
- No mention of the git commands involved

**Verdict: FAIL** — Incomplete options, no stacked PR guidance, no DAG limitation warning.

---

## Gaps Identified

### Critical Gaps (must fix — will cause data loss or broken behavior):

1. **Shutdown ordering is inverted** (Scenario 5 CRITICAL FAIL)
   - Agents default to: complete → shutdown → merge
   - Correct order: complete → integrate → shutdown
   - Worktrees are destroyed on shutdown; integration MUST happen first
   - The skill must make this a prominent, hard rule

2. **Detached HEAD worktree setup unknown** (Scenario 2)
   - Agents use `git worktree add ./path` without `--detach`
   - Wrong location (not `.claude/worktrees/<task-id>/`)
   - No concept of the agent contract (BASE recording, squash, report hash)

3. **Squash requirement absent from recovery** (Scenario 6)
   - Agents don't know that even recovered work must end as a single commit
   - Recovery spawn prompts need full task context + squash instructions

### Significant Gaps (will cause incorrect behavior):

4. **Integration ordering is incomplete** (Scenario 3)
   - Dependency order correct, but no "smallest diff first for independents" rule
   - No build + test verification after each cherry-pick
   - No concept of needing commit hash map before starting

5. **Team design misses implementation details** (Scenario 1)
   - No understanding of self-organizing vs lead-controlled semantics
   - No spawn prompt completeness requirement
   - No model selection reasoning (Sonnet default, Opus for complex/critical)
   - No agent type distinction (general-purpose vs Explore)

6. **Shipping strategy incomplete** (Scenario 7)
   - Only presents 2 options (single PR or many PRs)
   - Missing: stacked PRs as third option
   - Missing: linear chain requirement for stacked PRs
   - Missing: DAG fallback to single branch

### Minor Gaps (informal but correct):

7. **Conflict resolution process is informal** (Scenario 4)
   - Right decision (ask user), but no structured prompt format
   - No mention of reading both task specs before surfacing to user

### Patterns Observed:

- **Default toward shutdown-then-merge**: The most dangerous pattern. Agent assumes cleanup happens after work, not before shutdown.
- **Worktree commands wrong**: Agents know worktrees exist but not the specific flags or location conventions.
- **"Autonomy" used colloquially**: No awareness of self-organizing vs lead-controlled as technical settings.
- **Squash requirement unknown**: Agents produce multiple commits per agent; no awareness this breaks cherry-pick integration.
- **Verification step absent**: No mention of build + test after each cherry-pick in any scenario.
- **Spawn prompt requirements ignored**: Agents forget that teammates have no conversation history and need all context in spawn prompts.
