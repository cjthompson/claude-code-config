# claude-code-config

Custom configurations for Claude Code and Codex — skills, statusline, and an interactive installer. Also provides plugin marketplaces for easy skill installation.

## Claude Code Plugin Marketplace

Install skills directly using Claude Code's built-in plugin system:

```
/plugin marketplace add cjthompson/claude-code-config
```

Then browse and install individual plugins from the `/plugin` UI.

### Available Claude Code plugins

| Plugin | Description |
|--------|-------------|
| **project-tasks** | Capture tasks with `task:`/`fix:`/`todo:` prefixes, dispatch to subagents, auto-generate changelogs |
| **orchestration-strategy** | Select cost-efficient orchestration: solo, parallel, sequential, or Agent Teams |
| **agent-team-development** | End-to-end Agent Teams orchestration with worktree isolation and cherry-pick integration |
| **rust-coding** | Idiomatic Rust guidance: data modeling, traits, macros, build-speed best practices |
| **textual** | Textual Python TUI framework reference: CSS properties and widget APIs |

## Codex Plugin Marketplace

Install the repo-local Codex marketplace from the repository root:

```bash
codex plugin marketplace add .
```

Then install available Codex plugins by marketplace name:

```bash
codex plugin add rust-coding@cjthompson-codex-code-config
codex plugin add textual@cjthompson-codex-code-config
codex plugin add orchestration-strategy@cjthompson-codex-code-config
codex plugin add project-tasks@cjthompson-codex-code-config
```

Codex marketplace entries live in `.agents/plugins/marketplace.json`; each plugin has its Codex manifest at `plugins/<name>/.codex-plugin/plugin.json`.

### Available Codex plugins

| Plugin | Status | Description |
|--------|--------|-------------|
| **project-tasks** | Available | Host-aware task capture, SQLite storage, and changelog generation |
| **orchestration-strategy** | Available | Host-aware strategy selection for solo, parallel, sequential, or team-style work |
| **rust-coding** | Available | Idiomatic Rust guidance |
| **textual** | Available | Textual CSS and widget API references |
| **agent-team-development** | Not available | Requires Claude Code Agent Teams tools |
| **deep-planning** | Not available | Placeholder plugin with no Codex skill content yet |
| **output-styles** | Not available | Targets Claude Code `/output-style`, which is not a Codex plugin feature |

## Installer

For packages that aren't available as plugins (statusline, task-db helper), use the interactive TUI installer:

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

Custom skills for Claude Code and Codex, located in `plugins/<name>/skills/`. Claude Code metadata lives in `.claude-plugin/plugin.json`; Codex metadata lives in `.codex-plugin/plugin.json`.

### project-tasks

Capture tasks inline with `task:`, `fix:`, or `todo:` prefixes. Tasks are stored in a global SQLite database (`~/.claude/tasks.db` for Claude Code, `${CODEX_HOME:-~/.codex}/project-tasks/tasks.db` for Codex) and dispatched to subagents for execution so the lead agent stays available. Completed tasks auto-update `CHANGELOG.md`.

**Commands:** `task: <desc>`, `fix: <desc>`, `todo: <desc>`, `list tasks`, `run task #N`, `run all tasks`, `update changelog`

**Helper script:** the plugin includes `task-db.mjs` in the plugin payload and a skill-local wrapper at `skills/project-tasks/scripts/task-db.mjs`. The skill resolves that bundled helper first. The TUI installer still copies `task-db.mjs` to `~/.claude/task-db.mjs` as a legacy fallback for manual/symlink installs.

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
