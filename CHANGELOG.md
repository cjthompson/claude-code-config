# Changelog

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
