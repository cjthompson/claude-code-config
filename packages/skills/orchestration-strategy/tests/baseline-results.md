# orchestration-strategy Baseline Results (RED Phase)

Subagents ran WITHOUT the orchestration-strategy skill loaded.

## Scenario 1: High file overlap, dependency chains (expected: sequential subagents)

**Agent chose:** Sequential solo execution
**Correct decision?** Partially — correct that sequential is right, but said "solo" not "sequential subagents." Didn't consider subagent-driven-development as an orchestration option.
**Key reasoning:** "The flat App struct, single match block, and shared types.rs are structural barriers to parallelism." Good analysis of merge complexity.
**Gaps:** No mention of cost trade-offs. No awareness of re-evaluation at tier boundaries. Framed as "solo" (do it all yourself) rather than sequential subagents with review.

## Scenario 2: Independent tasks, no file overlap (expected: parallel agents, shared worktree)

**Agent chose:** Parallel agents in two phases
**Correct decision?** Yes — correctly identified parallelism opportunity and dependency ordering.
**Key reasoning:** Good dependency graph analysis. Respected task 3-4 dependencies on 1-2.
**Gaps:** No mention of worktree isolation (not needed here, but didn't reason about it). No mention of cost. No consideration of whether this even warrants orchestration (only 4 tasks).

## Scenario 3: Independent tasks WITH file overlap, trivial conflicts (expected: parallel agents + worktrees)

**Agent chose:** Parallel agents with batched mod.rs writes
**Correct decision?** Partially — correct about parallelism, but proposed batching mod.rs writes at the end rather than using worktree isolation + cherry-pick.
**Key reasoning:** Identified mod.rs as sole conflict point, correctly assessed changes as purely additive.
**Gaps:** No awareness of git worktree isolation as a strategy. Invented an ad-hoc "batch writes at the end" approach instead of using the established worktree + cherry-pick protocol. No mention of detached HEAD, squash, or commit hash reporting.

## Scenario 4: Cross-cutting feature (expected: agent teams)

**Agent chose:** Agent Teams with lead as contract negotiator
**Correct decision?** Yes — correctly identified need for inter-agent communication and chose teams.
**Key reasoning:** Excellent analysis — lead owns shared contract, agents pause and message when hitting boundaries, broadcast changes to all consumers.
**Gaps:** No mention of worktree isolation for the agents. No mention of cost (teams are 3-7x). No cherry-pick integration protocol. No discussion of shutdown ordering. No squash contract.

## Scenario 5: Simple task (expected: solo)

**Agent chose:** Solo sequential execution
**Correct decision?** Yes — correctly identified this doesn't warrant orchestration.
**Key reasoning:** "The added complexity of orchestrating two agents is not worth it for two edits to one file."
**Gaps:** None significant. Agent correctly chose solo for a trivial workload.

## Scenario 6: Worktree cost-benefit (expected: sequential for App.tsx tasks, parallel for independent tasks)

**Agent chose:** Sequential for 6 App.tsx tasks, parallel worktrees for 2 independent tasks
**Correct decision?** Yes — correctly split the approach.
**Key reasoning:** "Worktrees defer the conflict, they do not eliminate it." Excellent cost-benefit analysis. "If merging takes even 30-50% of the time saved by parallelizing, you have lost ground."
**Gaps:** Suggested refactoring App.tsx first (out of scope for orchestration decision). No mention of cherry-pick protocol for the 2 parallel tasks. No mention of detached HEAD or squash contract.

## Scenario 7: Teams not available, fallback (expected: fallback with trade-off explanation)

**Agent chose:** Sequential single-agent with contract-first approach
**Correct decision?** Yes — correctly fell back to sequential and explained trade-offs.
**Key reasoning:** Good trade-off explanation — listed 5 concrete trade-offs including slower wall-clock, later feedback loops, and context switching overhead.
**Gaps:** Didn't consider parallel agents as an intermediate option (backend + frontend could potentially be parallel agents with worktrees if they don't need real-time communication). Fell straight to fully sequential. No awareness of dispatching-parallel-agents as an option.

---

## Gaps Identified

### Consistent gaps across scenarios:
1. **No awareness of worktree isolation protocol** — agents never mentioned detached HEAD, squash to single commit, cherry-pick integration, or commit hash reporting. They either serialize or parallelize naively.
2. **No awareness of orchestration as a spectrum** — agents think in terms of "parallel" or "sequential" but don't consider the 4-level hierarchy (solo → parallel agents → sequential subagents → agent teams).
3. **No cost reasoning** — never mentioned token costs (Nx for agents, 3-7x for teams) as a factor in the decision.
4. **No merge complexity assessment** — Scenario 1 and 6 agents correctly identified semantic conflicts, but didn't frame it as a systematic "assess merge complexity" step. They intuited it rather than applying a framework.
5. **No handoff concept** — no awareness that choosing a strategy should come with explicit constraints communicated to the execution skill.
6. **No re-evaluation** — no agent mentioned re-evaluating the strategy after a batch of tasks completes.
7. **No cherry-pick protocol** — the entire integration protocol (worktree → squash → report hash → cherry-pick in dependency order → verify → resolve conflicts) is completely absent from baseline behavior.
8. **Scenario 3 gap: worktrees as parallelism enabler** — the agent invented an ad-hoc batching strategy instead of recognizing that worktree isolation makes file-overlapping tasks safely parallelizable.
