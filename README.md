# claude-code-config

Custom configurations for Claude Code — skills, statusline, and an interactive installer.

## Installer

Run the interactive TUI installer to select and install packages:

```bash
npm install
npm run install-packages
```

Uses a card-based interface. Navigate with `tab`/`↑↓`, toggle with `space`, view details with `i`, install with `enter`.

Adding a new package is convention-based: drop a `manifest.json` in `packages/<name>/` and the installer picks it up automatically.

## Skills

Custom skills for Claude Code, located in `packages/skills/`. Each skill is auto-discovered by the installer (any subdirectory with a `SKILL.md`).

### project-tasks

Capture tasks inline with `task:`, `fix:`, or `todo:` prefixes. Tasks are logged to `docs/TASKS.md` and dispatched to subagents for execution so the lead agent stays available. Completed tasks auto-update `docs/CHANGELOG.md`.

**Commands:** `task: <desc>`, `fix: <desc>`, `todo: <desc>`, `list tasks`, `run task #N`, `run all tasks`, `update changelog`

### orchestration-strategy

Evaluates multi-task workloads and selects the most cost-efficient orchestration approach: solo, parallel agents, sequential subagents, or Agent Teams. Analyzes file overlap and dependency graphs to determine isolation strategy, then hands off to the appropriate execution skill.

### agent-team-development

End-to-end Agent Teams orchestration for cross-cutting work requiring inter-agent communication. Manages team creation, worktree isolation, cherry-pick integration, and shutdown ordering. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to be enabled.

### rust-coding

Guides Claude in writing idiomatic Rust code with proper data modeling, traits, `impl` organization, macros, and build-speed best practices. Automatically triggers when working on `.rs` files or projects with a `Cargo.toml`.

## Statusline

A two-line powerline-style statusline for Claude Code showing session metrics and API quota usage. Located in `packages/statusline/`.

```
 Opus 4.6 │ $2.10 │ $12.60/hr │ 45% ████░░░░ │ ~1h1m left │ +100 -30 │ 10m ▶  ~/d/my-project ▶  improve-auth ▶
 5h 33% ████░░░░░░░░ 1h57m (2:00PM) │ 7d 16% ██░░░░░░░░░░ Fri 10:00AM │ (3m old) ▶
```

Both lines are width-aware — segments drop progressively as the terminal narrows.
