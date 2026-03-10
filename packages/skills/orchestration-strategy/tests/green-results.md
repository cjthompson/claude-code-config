# orchestration-strategy GREEN Results

Subagents ran WITH the orchestration-strategy skill loaded (prepended to each prompt).

## Scenario 1: High file overlap, dependency chains (expected: sequential subagents)

**Agent chose:** Sequential subagents, tier by tier
**Correct decision?** YES — correctly identified sequential subagents (not "solo sequential") with tier-based execution.
**Key improvements over baseline:**
- Used "sequential subagents" vocabulary (baseline said "solo")
- Cited merge complexity with concrete signals: "flat struct that owns all state" = semantic, "single match block" = semantic
- Applied >50% heuristic explicitly: "most tasks touch app.rs... definitionally over 50%"
- Included full handoff spec (skill, isolation, ordering, model selection)
- Mentioned re-evaluation after each tier
- Cost reasoning: "Agent Teams would be 3-7x cost with no benefit"

## Scenario 2: Independent tasks, no file overlap (expected: parallel agents, shared worktree)

**Agent chose:** Parallel agents with worktree isolation (two chains in parallel)
**Correct decision?** MOSTLY — correct parallelism and dependency analysis, but used worktree isolation when shared worktree suffices (zero file overlap). Minor over-engineering, not unsafe.
**Key improvements over baseline:**
- Correct 4-strategy vocabulary
- Good dependency chain analysis (two parallel chains)
- Full handoff spec with model selection
- Cost reasoning present

**Minor gap:** Skill says "no file overlap → shared worktree" but agent chose worktree isolation anyway. Errs on side of caution.

## Scenario 3: Independent tasks WITH file overlap, trivial conflicts (expected: parallel agents + worktrees)

**Agent chose:** Parallel agents with worktree isolation (detached HEAD per task)
**Correct decision?** YES — this is the critical scenario that failed at baseline. Now fully correct.
**Key improvements over baseline:**
- Used worktree isolation instead of ad-hoc batching (baseline invented "batch mod.rs writes at the end")
- Full agent contract: record BASE, squash to single commit, report hash
- Detached HEAD with `.claude/worktrees/<task-id>/` locations
- Cherry-pick integration in dependency order
- Correct merge complexity assessment: "purely additive" = trivial
- Downstream skill specified: `dispatching-parallel-agents`

## Scenario 4: Cross-cutting feature (expected: agent teams)

**Agent chose:** Agent Teams with lead-controlled autonomy
**Correct decision?** YES — correctly identified inter-agent communication need.
**Key improvements over baseline:**
- Cost acknowledgment: "3-7x compared to parallel agents... premium is justified"
- Worktree isolation per agent specified
- Cherry-pick protocol with integration ordering
- Autonomy level: lead-controlled with rationale
- TeamCreate detection: "Assume the TeamCreate tool IS available"
- Shutdown ordering implicit in integration flow

## Scenario 5: Simple task (expected: solo)

**Agent chose:** Solo
**Correct decision?** YES — correctly identified below threshold.
**Key improvements over baseline:**
- Cost reasoning: "1x cost", "~2x cost for no benefit"
- Clear reference to decision criteria: "Tasks < 3"
- No over-engineering

## Scenario 6: Worktree cost-benefit (expected: sequential for App.tsx, parallel for independent)

**Agent chose:** Sequential subagents for 6 App.tsx tasks, parallel agents + worktrees for 2 independent tasks
**Correct decision?** YES — correctly rejected colleague's suggestion and split the approach.
**Key improvements over baseline:**
- Applied >50% heuristic: "6/8 tasks (75%) all touch App.tsx"
- Named all three semantic signals: "single useState object", "large switch statement", "same syntactic region"
- Worktree cost-benefit analysis: "resolving those conflicts would almost certainly exceed the time saved"
- Worktrees viable for the 2 independent tasks
- Re-evaluation mentioned (integrate page components after sequential tasks complete)

## Scenario 7: Teams not available, fallback (expected: fallback with trade-off explanation)

**Agent chose:** Sequential subagents with explicit fallback explanation
**Correct decision?** YES — correctly identified need for teams, explained trade-off, chose appropriate fallback.
**Key improvements over baseline:**
- Explicit: "Agent Teams would be ideal... Since TeamCreate is unavailable"
- Concrete trade-offs: "you are the communication bus", "adds orchestrator attention cost"
- Phase-based execution with review gates
- Contract artifact management
- Model selection: Opus for backend (heaviest architectural work)
- Did NOT fall straight to fully sequential like baseline — structured it with review gates

---

## Summary: All 8 Baseline Gaps Addressed

| Gap | Status |
|-----|--------|
| 1. No worktree isolation protocol | FIXED (S3, S4, S6) |
| 2. No 4-strategy vocabulary | FIXED (all scenarios) |
| 3. No cost reasoning | FIXED (all scenarios) |
| 4. No merge complexity framework | FIXED (S1, S3, S6) |
| 5. No handoff concept | FIXED (S1-S4, S6-S7) |
| 6. No re-evaluation | FIXED (S1, S6) |
| 7. No cherry-pick protocol | FIXED (S3, S4) |
| 8. Ad-hoc batching instead of worktrees | FIXED (S3) |

## Minor Issue

S2 used worktree isolation when shared worktree would suffice. Not incorrect (just slightly over-cautious). The decision tree is clear; agent erred on side of safety. No skill change needed.
