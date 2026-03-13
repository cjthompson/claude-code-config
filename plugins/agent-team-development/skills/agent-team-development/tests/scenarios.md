# agent-team-development Test Scenarios

## Scenario 1: Team design (correct sizing and model selection)

You need to execute 15 implementation tasks using Agent Teams. The tasks span
3 subsystems (auth, API, frontend) with 5 tasks each. Tasks within a subsystem
are sequential (depend on each other). Tasks across subsystems are independent.

Design the team: How many teammates? What agent types? What model for each?
What autonomy level? Explain your reasoning.

## Scenario 2: Worktree isolation decision

You have a team of 3 agents working on independent subsystems. Agent A works on
`src/auth/`, Agent B on `src/api/`, Agent C on `src/frontend/`. No shared files.

Should you use worktree isolation? If so, how would you set it up?

Now imagine Agent A and Agent C both need to modify `src/types/shared.ts`.
Does your answer change?

## Scenario 3: Integration ordering

You have 5 completed tasks with these dependencies:
- Task 1: no dependencies (foundation)
- Task 2: depends on Task 1
- Task 3: depends on Task 1
- Task 4: depends on Task 2 and Task 3
- Task 5: no dependencies (independent)

Task diffs: Task 1 = 200 lines, Task 2 = 50 lines, Task 3 = 150 lines,
Task 4 = 80 lines, Task 5 = 30 lines.

Each agent worked in a detached HEAD worktree and reported a commit hash.
In what order do you cherry-pick? Explain your reasoning.

## Scenario 4: Conflict resolution

You're cherry-picking Task 3 after successfully integrating Task 1 and Task 2.
The cherry-pick fails with a conflict in `src/app.rs`:

<<<<<<< HEAD (Task 2: status bar)
    KeyCode::Char('s') => self.toggle_status_bar(),
=======
    KeyCode::Char('s') => self.sort_branches(),
>>>>>>> (Task 3: column sorting)

Task 2's spec says: "Add 's' keybinding to toggle status bar visibility"
Task 3's spec says: "Add 's' keybinding to cycle sort order on current column"

How do you resolve this? When should you ask the user vs auto-resolve?

## Scenario 5: Shutdown ordering (CRITICAL)

All 3 teammates have reported task completion. Their worktrees contain the commits.
You haven't integrated any changes yet. A teammate sends: "All done! Ready to shut down."

What do you do? Walk through the exact steps.

## Scenario 6: Error recovery — crashed teammate

Teammate B was working on Task 4 in `.claude/worktrees/task-4/`. Teammate B
has become unresponsive. You check the worktree and find:
- 3 intermediate commits
- Uncommitted changes in 2 files
- Tests were last run and passed 2 commits ago

What do you do? Walk through recovery steps.

## Scenario 7: Shipping strategy decision

You've integrated 8 tasks via cherry-pick onto your current branch.
The user says "I want to create PRs for this work."

The tasks have this dependency structure:
- Tasks 1-3: linear chain (1 → 2 → 3)
- Tasks 4-5: independent of each other and of 1-3
- Tasks 6-8: linear chain (6 → 7 → 8), independent of 1-5

What shipping options do you present? What are the trade-offs?
