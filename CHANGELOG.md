# Changelog

## v0.0.26 - 2026-06-03

### Features
- Statusline context segment now appends the absolute context-window maximum in parentheses after the progress bar, e.g. `80% ████░░░░ (200K)` or `80% ████░░░░ (1M)`. Lets you see at a glance which model class is active. Renders via new `formatTokenCount` helper; gracefully omitted when `context_window_size` is absent (early-session case). Adds 10 tests (7 unit + 3 E2E).

## v0.0.25 - 2026-06-03

### Fixes
- Extend `task-db` `update` command to support all task fields: `--type`, `--title`, `--created`, `--completed-at`, `--feedback`, and repeatable `--tag`, `--req`, `--dep` flags. Adds `feedback` and `completed_at` columns via migration in the `init` command.

## v0.0.24 - 2026-05-20

### Features
- Add `output-styles` package shipping a new `Concise` style — terse one-or-two-sentence answers and action lists routed into TaskCreate calls. Install with `npm run install-package output-styles` and select via Claude Code's `/output-style` picker.

### Fixes
- Installer (`installFiles`) now creates parent directories before copying, enabling `files`-type packages to ship files into nested paths like `output-styles/<name>.md`.

## v0.0.23 - 2026-04-30

### Tasks
- Add two-entry TaskList approach: Scout and Execute as separate TaskList entries
- Add 2-stage pipeline test document with full state transition coverage (pending → scouting → executing → completed)
- Add comment to test-run-task.md noting it covers pre-2-stage single-agent dispatch
- Add test task demonstrating 2-stage pipeline execution with persistent task list

## v0.0.22 - 2026-03-30

### Fixes
- Remove dead `depends_on` column migration from task-db init that caused "duplicate column name" error on existing databases
- Remove one-off `migrate-tasks.ts` script and associated npm scripts — markdown-to-SQLite migration is complete

## v0.0.21.1 - 2026-03-21

### Features
- Installer now compares SHA-256 hashes of source vs installed files to detect outdated packages
- Files packages show `(current)` when hashes match, `(upgrade)` when outdated, `(installed)` for symlinked items
- Cards show yellow "UPGRADE" badge when updates are available
- Results view distinguishes "Updated" from "Copied" for reinstalled files

### Fixes
- Fix task-db.mjs "duplicate column name: depends_on" error by removing unnecessary ALTER TABLE migration
- Add "never delete tasks.db" rule to project-tasks skill to prevent data loss

## v0.0.21 - 2026-03-18

### Features
- Add `log task:` and `log fix:` prefix shortcuts to project-tasks skill — always saves as Log Only without presenting the execution prompt
- Add `run task:` and `run fix:` prefix shortcuts — logs the task and immediately runs it through the full execution pipeline (Check Dependencies → Isolation → Scout + Executor)

## v0.0.20 - 2026-03-15

### Features
- Upgrade project-tasks skill to 2-stage execution pipeline: Sonnet scout (read-only) produces Implementation Map with ownership analysis, then Haiku executor follows it mechanically
- Add ownership analysis step to scout prompt — guides models to place state on data-owning classes and logic in shared modules, improving cross-file architectural judgment by ~29%
- Fix invalid `subagent_type: "haiku"` in check-task section (now uses `subagent_type: "general-purpose"` with `model: "haiku"`)

## v0.0.19 - 2026-03-13

### Features
- Add Claude Code plugin marketplace — skills are now installable via `/plugin marketplace add cjthompson/claude-code-config`
- Restructure skills from `packages/skills/` to `plugins/<name>/` following the Claude Code plugin format
- Each skill is a standalone plugin with `.claude-plugin/plugin.json` and marketplace index at `.claude-plugin/marketplace.json`
- Update TUI installer to discover skills from `plugins/` directory

## v0.0.18 - 2026-03-13

### Tasks
- Add `task-db.mjs` helper script package — wraps all SQLite operations in a simple CLI, replacing raw sqlite3 calls in the project-tasks skill and reducing bash permissions to a single `Bash(node ~/.claude/task-db.mjs *)` entry

## v0.0.17 - 2026-03-13

### Fixes
- Switch project-tasks INSERT statements to quoted heredoc to fix sqlite3 escaping errors when values contain single quotes; update permission tip to include `Bash(P=*)`

## v0.0.16 - 2026-03-13

### Tasks
- Add first-time setup tip to project-tasks skill suggesting `Bash(sqlite3 *)` permission in `~/.claude/settings.json` to avoid sqlite3 approval prompts

## v0.0.15 - 2026-03-10

### Tasks
- Add `depends_on` support to project-tasks skill — tasks can declare dependencies on other tasks, blocked tasks shown in listings, dispatch prevented until deps complete

## v0.0.14 - 2026-03-10

### Tasks
- Add one-off migration script (`npm run migrate-tasks`) to migrate existing docs/TASKS.md files into the global SQLite database

## v0.0.13 - 2026-03-10

### Tasks
- Migrate project-tasks storage from markdown (docs/TASKS.md) to SQLite (~/.claude/tasks.db) for reduced token usage — tasks scoped per-project, queried via sqlite3 CLI, with in_changelog tracking column

## v0.0.12 - 2026-03-10

### Tasks
- Skill defers git commit until user selects Accept

## v0.0.10 - 2026-03-10

### Tasks
- Defer git commit to Accept step in project-tasks skill — subagent no longer commits; lead agent commits after user accepts

## v0.0.9 - 2026-03-10

### Features
- Add `install-package` non-interactive CLI (`npm run install-package <name> [<name>...]`) to install specific packages or skills by name without launching the TUI. Names are matched case-insensitively against package IDs, labels, and individual item names. Exits non-zero if any name is not found or any install fails.

## v0.0.8 - 2026-03-10

### Features
- Add `reinstall` npm script (`npm run reinstall`) that non-interactively detects already-installed packages and reinstalls them, using the same discovery and install logic as the main installer

## v0.0.7 - 2026-03-09

### Docs
- Add "Repository-Based Changes" section to CLAUDE.md clarifying how to make changes to repo-contained items (skills, configs) and how to apply them using `npm run install-packages`

## v0.0.5 - 2026-03-09

### Tasks
- Change `todo:` prefix to always Log Only — skip execution choice prompt and save as pending with no dispatch

## 2026-03-09

### Features
- Add custom skills: agent-team-development, orchestration-strategy, project-tasks, rust-coding
- Add skill install script

### Docs
- Add skills section to README

## 2026-02-28

### Tasks
- Improve display with wrapping and powerline symbols

## 2026-02-27

### Tasks
- Dynamically adjust sections based on terminal width

## 2026-02-25

### Tasks
- Add statusline script
- Initial commit
