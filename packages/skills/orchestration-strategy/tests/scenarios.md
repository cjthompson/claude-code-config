# orchestration-strategy Test Scenarios

## Scenario 1: High file overlap, dependency chains (should → sequential)

You have an implementation plan with 12 tasks for a Rust TUI app. The backlog has
4 tiers of dependencies. Most tasks modify `app.rs` (event handling, state),
`types.rs` (shared data types), and `ui/branch_list.rs` (rendering). The `App`
struct is a flat struct that owns all state. Key events are handled in a single
`match` block that most tasks would add arms to.

You need to execute this plan. How would you orchestrate the work — solo, parallel
agents, sequential subagents, or agent teams? Explain your reasoning, including
what specific factors led to your decision.

## Scenario 2: Independent tasks, no file overlap (should → parallel agents, shared worktree)

You have 4 tasks to implement:
1. Add a new CLI command in `src/commands/export.rs` (new file)
2. Add a new CLI command in `src/commands/import.rs` (new file)
3. Write integration tests in `tests/export_test.rs` (new file)
4. Write integration tests in `tests/import_test.rs` (new file)

Tasks 1-2 are independent. Tasks 3-4 depend on 1-2 respectively but not on each other.
No existing files are modified. How would you orchestrate this?

## Scenario 3: Independent tasks WITH file overlap, trivial conflicts (should → parallel agents + worktrees)

You have 5 tasks that each add a new subcommand to a CLI tool:
1. Add `analyze` command — creates `src/commands/analyze.rs`, adds 1 line to `src/commands/mod.rs`
2. Add `validate` command — creates `src/commands/validate.rs`, adds 1 line to `src/commands/mod.rs`
3. Add `format` command — creates `src/commands/format.rs`, adds 1 line to `src/commands/mod.rs`
4. Add `lint` command — creates `src/commands/lint.rs`, adds 1 line to `src/commands/mod.rs`
5. Add `migrate` command — creates `src/commands/migrate.rs`, adds 1 line to `src/commands/mod.rs`

Each task creates a new file and adds one `mod` declaration line to `mod.rs`.
The mod.rs changes are purely additive (no shared structs, no logic).
How would you orchestrate this?

## Scenario 4: Cross-cutting feature needing inter-agent communication (should → agent teams)

You're building a real-time notifications feature that spans:
- Backend: WebSocket server, event system, database schema changes
- Frontend: Notification component, WebSocket client, state management
- Shared: API contract (message format) that both sides must agree on

The frontend needs to ask the backend about payload structure mid-implementation.
When the API contract changes, both sides need to update. The backend might discover
limitations that require negotiating alternatives with the frontend.

How would you orchestrate this? Assume CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is enabled.

## Scenario 5: Simple task (should → solo)

You have 2 tasks:
1. Add a `--verbose` flag to an existing CLI command
2. Update the help text for that command

Both tasks modify `src/cli.rs`. How would you orchestrate this?

## Scenario 6: Worktree cost-benefit (should → sequential despite worktrees being available)

You have 8 tasks for a React app. 6 of them modify `App.tsx` (the main component
with all state in a single useState object and a large switch statement for routing).
The other 2 add new page components in separate files.

A colleague suggests using git worktrees to parallelize all 8 tasks.
Should you? Explain your reasoning about the cost-benefit of worktree isolation here.

## Scenario 7: Teams not available, cross-cutting work (should → fallback with explanation)

Same as Scenario 4 (real-time notifications), but CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
is NOT enabled. The TeamCreate tool is not available.

How would you orchestrate this? What trade-offs do you explain to the user?
