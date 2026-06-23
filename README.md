# claude-code-config

Custom configurations for Claude Code — skills, statusline, and an interactive installer. Also a plugin marketplace for easy one-command skill installation.

## Plugin Marketplace

Install skills directly using Claude Code's built-in plugin system:

```
/plugin marketplace add cjthompson/claude-code-config
```

Then browse and install individual plugins from the `/plugin` UI.

### Available plugins

| Plugin | Description |
|--------|-------------|
| **project-tasks** | Capture tasks with `task:`/`fix:`/`todo:` prefixes, dispatch to subagents, auto-generate changelogs |
| **orchestration-strategy** | Select cost-efficient orchestration: solo, parallel, sequential, or Agent Teams |
| **agent-team-development** | End-to-end Agent Teams orchestration with worktree isolation and cherry-pick integration |
| **rust-coding** | Idiomatic Rust guidance: data modeling, traits, macros, build-speed best practices |

## Installer

For packages that aren't available as plugins (statusline, claude-optin), use the interactive TUI installer:

```bash
npm install
npm run install-packages
```

Uses a card-based interface. Navigate with `tab`/`↑↓`, toggle with `space`, view details with `i`, install with `enter`.

To install one or more packages by name without the TUI (fully non-interactive):

```bash
npm run install-package statusline
```

Names are matched case-insensitively against package IDs, package labels, and individual item names. Exits non-zero if any name is not found or if any install fails.

The installer also discovers skills from `plugins/`, so you can use it to symlink-install plugin skills locally if you prefer that workflow over the plugin system.

## Skills

Custom skills for Claude Code, located in `plugins/<name>/skills/`. Each skill is a standalone Claude Code plugin with its own `.claude-plugin/plugin.json`.

### project-tasks

Capture tasks inline with `task:`, `fix:`, or `todo:` prefixes. Tasks are stored in a global SQLite database (`~/.claude/tasks.db`) and dispatched to subagents for execution so the lead agent stays available. Completed tasks auto-update `CHANGELOG.md`.

**Commands:** `task: <desc>`, `fix: <desc>`, `todo: <desc>`, `list tasks`, `run task #N`, `run all tasks`, `update changelog`

**Project identity:** the task list is keyed by a per-project name. Create `.claude/project-tasks.json` at the project root with `{"projectName": "github.com/owner/repo"}` to lock in a stable identifier (recommended — keeps the list consistent across agents, worktrees, and clones). Without it, the skill falls back to the git remote URL or directory basename and prompts you to create the file the first time.

### orchestration-strategy

Evaluates multi-task workloads and selects the most cost-efficient orchestration approach: solo, parallel agents, sequential subagents, or Agent Teams. Analyzes file overlap and dependency graphs to determine isolation strategy, then hands off to the appropriate execution skill.

### agent-team-development

End-to-end Agent Teams orchestration for cross-cutting work requiring inter-agent communication. Manages team creation, worktree isolation, cherry-pick integration, and shutdown ordering. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to be enabled.

### rust-coding

Guides Claude in writing idiomatic Rust code with proper data modeling, traits, `impl` organization, macros, and build-speed best practices. Automatically triggers when working on `.rs` files or projects with a `Cargo.toml`.

## Output Styles

Custom Claude Code output styles, installed into `~/.claude/output-styles/` and selectable via `/output-style`. Located in `packages/output-styles/`. Install via the TUI installer or `npm run install-package output-styles`.

| Style | Description |
|-------|-------------|
| **Concise** | Terse one-or-two-sentence answers; action lists are captured as tasks rather than buried in prose |

## Statusline

A two-line powerline-style statusline for Claude Code showing session metrics and API quota usage. Located in `packages/statusline/`. Install via the TUI installer.

```
 Opus 4.6 │ $2.10 │ $12.60/hr │ 45% ████░░░░ │ ~1h1m left │ +100 -30 │ 10m ▶  ~/d/my-project ▶  improve-auth ▶
 5h 33% ████░░░░░░░░ 1h57m (2:00PM) │ 7d 16% ██░░░░░░░░░░ Fri 10:00AM │ (3m old) ▶
```

Both lines are width-aware — segments drop progressively as the terminal narrows.

## claude-optin

A curses TUI to manage per-repo Claude Code plugin opt-ins. Lists every installed plugin (with its skills and agents), shows the effective enabled state and where it comes from (user / project / local settings), and lets you toggle a local override. Located in `packages/claude-optin/`. Install via the TUI installer or `npm run install-package claude-optin` (installs to `~/.local/bin/`), then run `claude-optin` from inside a repo (assuming `~/.local/bin` is on your `PATH`).

Toggles are written to `<repo>/.claude/settings.local.json` (gitignored, personal); with `--global`/`-g`/`--user` they edit the user-level defaults in `~/.claude/settings.json` instead.
