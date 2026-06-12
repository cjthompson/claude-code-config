# Changelog

## v0.0.35 - 2026-06-12

### Fixes
- **textual/textual-api-reference**: validated all 37 widgets against official docs; removed 5 fabricated messages/attributes, corrected 10 wrong defaults, fixed 6 wrong APIs, added ListItem (missing widget), Footer reactive attrs, shared attributes section, and ToggleButton base documentation.

## v0.0.34 - 2026-06-12

### Features
- **tests**: add `tests/` directory infrastructure mirroring `plugins/` and `packages/` layout, with `README.md`, `index.md`, and `test-results.md` in each subdirectory. Textual plugin gets `test-textual-css-reference.md` and `test-textual-api-reference.md` with MUST/MUST NOT acceptance criteria.
- **skill-testing**: new package with `SKILL.md` documenting the full skill-testing process — directory structure, scenario file format, baseline (RED) + GREEN test runs, and PASS/FAIL/PARTIAL evaluation criteria.

## v0.0.33 - 2026-06-12

### Features
- **textual**: new plugin with two reference skills — `textual-css-reference` (valid CSS properties, types, invalid properties, and common mistakes) and `textual-api-reference` (complete built-in widget reference covering all widgets with reactive attributes, constructor parameters, and messages emitted). Registered in marketplace.json.

## v0.0.32 - 2026-06-07

### Features
- **project-tasks**: replace the single-line `git remote || basename` project lookup with a 3-tier mechanism — Tier 1 walks up from cwd to the git toplevel (or `/` when not in a git repo) looking for `.claude/project-tasks.json`; Tier 2 falls back to a normalized git remote URL (matches `normalizeProject()` in `task-db.mjs`, so SSH/HTTPS/with-or-without-`.git` collapse to the same key); Tier 3 falls back to the git toplevel basename in git repos only. When all three tiers return empty, the skill now prompts the user to provide a name and offers to create `.claude/project-tasks.json` — preventing the silent directory-basename fallback that fragmented task lists across agents and worktrees. Project reads trim whitespace and tolerate malformed JSON; project writes use `JSON.stringify` so quoted/escaped names round-trip correctly. README updated.
- **project-tasks**: new test `test-project-discovery.md` covers all four scenarios (file at project root, file at project root with nested cwd, no file with git remote, no file and no git).

## v0.0.31 - 2026-06-04

### Features
- **task-db**: canonicalize project name at the SQL boundary via `normalizeProject()`, so all URL forms (SSH/HTTPS, with/without `.git`, with/without trailing slash) collapse to the same `host/owner/repo` key. Future inserts/queries automatically land in the right list.
- **task-db**: new `migrate` subcommand rebuilds the `project` column for existing fragmented data. SELECT DISTINCT project → run each through the normalizer → build a (old → new) map → renumber `seq` per source to `MAX(target.seq)+1` (so the `UNIQUE(project, seq)` constraint can't trip on overlapping seqs) → bulk-update `project`. Idempotent; a second run is a no-op.

## v0.0.30 - 2026-06-04

### Fixes
- **Statusline**: fix root cause of `(0/200K)` display — Claude Code 2.x moved token counts into `context_window.current_usage` and added `total_input_tokens` as the authoritative sum; `totalContextTokens` now reads these correctly instead of looking for flat top-level fields that no longer exist

## v0.0.29 - 2026-06-04

### Fixes
- **Statusline**: fix `(0/200K)` display when Claude Code sends only `used_percentage` (not `input_tokens`/`cache_*` fields) — now derives approximate token count as `round(pct * windowSize / 100)`; also restores time-to-fill ETA which was silently suppressed in the same scenario

## v0.0.28 - 2026-06-04

### Fixes
- **Statusline**: clamp displayed percentage to 100 when tokens exceed the effective window size (an over-100% value was printed as raw text alongside a maxed bar)
- **Statusline**: unify bar and ETA numerators via `totalContextTokens()` — both now use `input_tokens + cache_creation + cache_read` so they agree on "used"
- **Statusline**: normalize model display names for override lookup by stripping `"Claude "` prefix and `"(NM context)"` suffixes, preventing silent override loss on Anthropic version renames
- **Statusline**: add `existsSync` short-circuit to config loader (avoids wasted syscall + exception per render when config is absent); distinguish parse errors from missing-file and warn on malformed JSON
- **Statusline**: harden all e2e config-writing tests with `try/finally` cleanup so a failed assertion never leaves a stale `statusline-config.json` in the source tree
- **Statusline**: ship `statusline-config.json` example config; installer seeds it to `~/.claude/`; update README for `sections` whitelist (replaces the old `disabledSections` blacklist)
- **Statusline**: add regression tests for clamping, ETA/bar consistency, and normalized model name matching; fix pre-existing test bugs (progressBar space char, shortenPath single-segment preservation, branch prefix stripping, PCT glyph vs ASCII %, used/max format)

## v0.0.27 - 2026-06-03

### Features
- Statusline now supports per-model context-window size overrides via `~/.claude/statusline-config.json`. Configure custom window sizes with a `modelContextWindows` map (e.g. `{"Claude Sonnet 4.6": 200000}`). The percentage calculation is now token-based, accounting for cache tokens: `round((input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / context_window_size * 100)`, with fallback to `used_percentage` for backward compatibility. New functions `resolveContextWindowSize` and `computeUsedPct` are exported and tested. Adds 18 new tests (7 + 10 unit + 1 E2E).

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
