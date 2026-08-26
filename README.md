# claude-code-config

Custom configurations for Claude Code — skills, statusline, and an interactive installer. Also a plugin marketplace for easy one-command skill installation.

## Plugin Marketplace

Install skills directly using Claude Code's built-in plugin system:

```
/plugin marketplace add cjthompson/claude-code-config
```

Then browse and install individual plugins from the `/plugin` UI.

The Python and TypeScript development plugins also include Codex manifests and are listed in the repo-local Codex marketplace. From this checkout, add it with `codex plugin marketplace add .agents/plugins`, then install a listed language plugin by name. Cursor manifests are included alongside them.

### Available plugins

| Plugin | Description |
|--------|-------------|
| **project-tasks** | Capture tasks with `task:`/`fix:`/`todo:` prefixes, group them under `plan:` epics, dispatch to subagents, auto-generate changelogs |
| **lean-agents** | Reduced-toolset sub-agent profiles (`lean-executor`, `standard-executor`, `main`, `full-executor`) that lower System-tools token overhead vs. spawning the default agent; pairs with `project-tasks`, which dispatches by name |
| **output-styles** | Custom output styles (`Concise`, `Terse`) selectable via `/output-style` |
| **orchestration-strategy** | Select cost-efficient orchestration: solo, parallel, sequential, or Agent Teams |
| **agent-team-development** | End-to-end Agent Teams orchestration with worktree isolation and cherry-pick integration |
| **rust-coding** | Idiomatic Rust guidance: data modeling, traits, macros, build-speed best practices |
| **textual** | Reference skills for the Textual Python TUI framework — valid CSS properties and complete widget API with reactive attributes |
| **command-watchdog** | Idle-hang detection for Bash commands (rspec, any `.sh` script) — kills silently-stuck runs after a configurable timeout |
| **python-scripting** | One-off Python helpers, practical typing, standalone-file quality checks, and standard-library macOS automation |
| **python-development** | Deep Python standards, testing, repository tooling and quality checks, concurrency, the full typing specification, and focused type tightening |
| **typescript-development** | Deep TypeScript standards, testing, project tooling, modules and packaging, focused official references, and low-churn type tightening |

## Installer

For packages that aren't available as plugins (statusline, claude-optin, git-utils), use the interactive TUI installer (implemented in `packages/installer/`):

```bash
npm install
npm run install-packages
```

Uses a flat checklist. Navigate with `↑↓`, toggle with `space`, view details with `i`, apply with `enter`. Only `packages/` entries are shown — plugins are installed via the Claude Code marketplace.

`enter` applies whatever is pending — installs, removals, or both. With nothing selected it re-applies the packages already installed, so it doubles as a repair/confirm pass: unchanged files report `already up to date` and are not rewritten.

To install one or more packages by name without the TUI (fully non-interactive):

```bash
npm run install-package statusline
```

Names are matched case-insensitively against package IDs, package labels, and individual item names. Exits non-zero if any name is not found or if any install fails.

## Skills

Custom skills for Claude Code, located in `plugins/<name>/skills/`. Each skill is a standalone Claude Code plugin with its own `.claude-plugin/plugin.json`.

### project-tasks

Capture tasks inline with `task:`, `fix:`, or `todo:` prefixes. `PROJECT_TASKS_HOME` selects the directory containing `tasks.db`. The Claude default is `~/.claude/tasks.db`; the Codex default is `$CODEX_HOME/project-tasks/tasks.db`, falling back to `$HOME/.codex/project-tasks/tasks.db`. Tasks are dispatched to subagents for execution so the lead agent stays available. Completed tasks auto-update `CHANGELOG.md`.

**Commands:** `task: <desc>`, `fix: <desc>`, `todo: <desc>`, `list tasks`, `run task #N`, `run all tasks`, `update changelog`

**Project identity:** the task list is keyed by a per-project name. Create `.claude/project-tasks.json` at the project root with `{"projectName": "github.com/owner/repo"}` to lock in a stable identifier (recommended — keeps the list consistent across agents, worktrees, and clones). Without it, the skill falls back to the git remote URL or directory basename and prompts you to create the file the first time.

**Plans (v2):** a plan is an epic — one document plus the tasks derived from it. `plan: <description>` writes the document into the database; `plan: /abs/path/to/doc.md` offers to either import the file (and delete it) or link to it, leaving it authoritative on disk.

Plans use the `P###` ID space (for example, `P001`); ordinary tasks use the separate `#NNN` ID space (for example, `#001`).

Tasks created from a plan carry an *anchor*, a slug of the step heading they came from, so the document and the task list stay joined. When the document changes, `plan propose` re-reads it and stages the candidate, printing a diff; `plan apply` commits it or `plan discard` drops it. Staging is what makes review trustworthy — a command that diffed and committed at once could commit a document that changed after you read the diff, so `plan apply` verifies the bytes it promotes still hash to what was reviewed.

`plan status` renders the document annotated with each step's progress; `plan progress` is a standalone report (table plus a short written summary, or `--counts` for a machine-readable line). Plans are global, so a single plan can own tasks in several repositories.

**Commands:** `plan: <desc|path>`, `list plans`, `show plan P00N`, `run plan P00N`, `update plan P00N`, `close plan P00N`, `cancel plan P00N`

> **Upgrading to 2.0:** the `task-db` helper moved from 13 flat commands to a nested surface (`task add`, `task deps blocked`, `plan note add`, …). There are no aliases — every old name errors with a message naming its replacement. The database itself migrates additively in place; no task is renumbered and nothing is rebuilt. Only the skill invokes the helper directly, so this matters only if you scripted against it.

### orchestration-strategy

Evaluates multi-task workloads and selects the most cost-efficient orchestration approach: solo, parallel agents, sequential subagents, or Agent Teams. Analyzes file overlap and dependency graphs to determine isolation strategy, then hands off to the appropriate execution skill.

### agent-team-development

End-to-end Agent Teams orchestration for cross-cutting work requiring inter-agent communication. Manages team creation, worktree isolation, cherry-pick integration, and shutdown ordering. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to be enabled.

### rust-coding

Guides Claude in writing idiomatic Rust code with proper data modeling, traits, `impl` organization, macros, and build-speed best practices. Automatically triggers when working on `.rs` files or projects with a `Cargo.toml`.

### python-scripting

Concise guidance for one-off helpers and standalone Python scripts. It loads before shell-based Python invocations, keeps incidental coding-session helpers standard-library-only and proportionate, covers practical type safety and Ruff and ty checks for standalone files without a governing repository toolchain, and supports macOS utilities that run with `/usr/bin/python3` using only Python 3.9-compatible standard-library imports. Stable macOS command-line utilities may be invoked through `subprocess` when Python has no suitable API.

### python-development

Deeper project-level guidance for production Python design, pytest strategy, existing and new repository toolchains, repository-scoped formatting, linting and type checking, asyncio and concurrency, and systematic annotation tightening. It vendors a commit-pinned copy of the complete Python typing specification and Honnibal's `tighten-types` workflow; run `node plugins/python-development/scripts/sync-typing-references.mjs --check` to verify the offline snapshot.

### typescript-development

Framework-neutral, project-level guidance for production TypeScript design, runtime-boundary validation, runtime and compile-time testing, repository-first tool configuration, ESM/CJS and package compatibility, difficult type-system questions, and focused annotation tightening. It vendors a commit-pinned, curated subset of Microsoft's official Handbook, modules, declaration-file, and TSConfig documentation; run `node plugins/typescript-development/scripts/sync-typescript-references.mjs --check` to verify the offline snapshot.

The plugin ships a TypeScript 7 language server at `.lsp.json` for `.ts`/`.tsx`/`.mts`/`.cts`. The config launches `${CLAUDE_PLUGIN_ROOT}/scripts/typescript-lsp.mjs`, an LSP-aware recovery proxy. It delegates all executable discovery to the unchanged `scripts/typescript-lsp.sh --check` control path: `$TS_LSP_BIN` → project `./node_modules/.bin/tsc` (only if it reports TypeScript 7) → `$PATH` → common Homebrew paths. That project-local lookup is intentional. Install TypeScript 7 globally (`npm i -g typescript@7`), in the project, or set `$TS_LSP_BIN`.

Unlike a generic restart loop, the Node proxy retains current open-document text, configuration, and workspace changes. If native `tsc` crashes, it retries five times with a 250 ms–4 s exponential backoff, internally initializes a replacement, replays that state, and then releases up to 10 seconds/1 MiB of queued client traffic. Diagnostics go only to stderr; after recovery is exhausted, it exits nonzero so Claude Code's `maxRestarts: 3` creates a fully fresh session. The Bash script remains directly runnable as the lower-complexity comparison launcher.

## Hooks

Custom Claude Code hooks, located in `plugins/<name>/hooks/`. Like skills, each is a standalone plugin with its own `.claude-plugin/plugin.json`.

### command-watchdog

A `PreToolUse` hook on the `Bash` tool. Any command matching a regex in `hooks/watchdog-patterns.txt` (ships with `rspec` and any `.sh` script by default) runs under an idle-hang watchdog instead of directly: it tees output live and kills the command if both stdout/stderr *and* the process group's cumulative CPU time stay flat for a configurable window (default 90s). A slow-but-working command (silent, but burning CPU) is left alone; a true hang (silent and CPU-flat) gets killed and dumps a diagnostic (`ps` tree + a `sample` stack trace) before doing so.

Commands that don't match any pattern are delegated to `rtk hook claude` if `rtk` is installed, otherwise passed through unmodified.

To add a pattern, edit `plugins/command-watchdog/hooks/watchdog-patterns.txt` — one `<regex>  [idle_seconds]` per line. See the file's header comment for the exact matching rules.

## Output Styles

Custom Claude Code output styles, installed into `~/.claude/output-styles/` and selectable via `/output-style`. Located in `plugins/output-styles/`. Install via the TUI installer or `npm run install-package output-styles`.

| Style | Description |
|-------|-------------|
| **Concise** | Terse one-or-two-sentence answers; action lists are captured as tasks rather than buried in prose |
| **Terse** | Headline-and-bullet answers with all process narration stripped; every reply reporting work closes with a `Result` status block; detail loads only on request |

## Statusline

A two-line powerline-style statusline for Claude Code showing session metrics and API quota usage. Located in `packages/statusline/`. Install via the TUI installer.

```
 8/12 3:45 PM ▶  Opus 4.6 │ $2.10 │ $12.60/hr │ 45% ████░░░░ │ ~1h1m left │ +100 -30 │ 10m ▶  ~/d/my-project ▶  improve-auth ▶
 5h 33% ████░░░░░░░░ 1h57m (2:00PM) │ 7d 16% ██░░░░░░░░░░ Fri 10:00AM │ (3m old) ▶
```

Both lines are width-aware — segments drop progressively as the terminal narrows.

## git-utils

Workspace-level git status and sync tools. Located in `packages/git-utils/`. Install via the TUI installer or `npm run install-package git-utils` (installs `repos` to `~/.local/bin/`).

`repos` scans every sub-repo in a workspace directory and reports branch, ahead/behind status, local changes, and open PRs for each. Run `repos --sync` to non-interactively pull/push repos that are in sync range. Requires `git`, `gh`, and `jq`.

## claude-optin

A curses TUI to manage per-repo Claude Code opt-ins across three tabs: Plugins (with their skills and agents), MCP servers (discovered from `.mcp.json` files and `~/.claude.json`), and individual Skills (personal, project, and active-plugin, each with its own `on`/`name-only`/`user-invocable-only`/`off` state). Shows the effective state and where it comes from (user / project / local settings) and lets you toggle a local override. Located in `packages/claude-optin/`. Install via the TUI installer or `npm run install-package claude-optin` (installs to `~/.local/bin/`), then run `claude-optin` from inside a repo (assuming `~/.local/bin` is on your `PATH`).

Toggles are written to `<repo>/.claude/settings.local.json` (gitignored, personal); with `--global`/`-g`/`--user` they edit the user-level defaults in `~/.claude/settings.json` instead.
