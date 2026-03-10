# claude-code-config
Custom configurations for claude code

## Skills

Custom skills for Claude Code, located in `packages/skills/`. Run `packages/skills/install.sh` to symlink them into `~/.claude/skills/`.

### project-tasks

Capture tasks inline with `task:`, `fix:`, or `todo:` prefixes. Tasks are logged to `docs/TASKS.md` and dispatched to subagents for execution so the lead agent stays available. Completed tasks auto-update `docs/CHANGELOG.md`.

**Commands:** `task: <desc>`, `fix: <desc>`, `todo: <desc>`, `list tasks`, `run task #N`, `run all tasks`, `update changelog`

### orchestration-strategy

Evaluates multi-task workloads and selects the most cost-efficient orchestration approach: solo, parallel agents, sequential subagents, or Agent Teams. Analyzes file overlap and dependency graphs to determine isolation strategy, then hands off to the appropriate execution skill.

### agent-team-development

End-to-end Agent Teams orchestration for cross-cutting work requiring inter-agent communication. Manages team creation, worktree isolation, cherry-pick integration, and shutdown ordering. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to be enabled.

### rust-coding

Guides Claude in writing idiomatic Rust code with proper data modeling, traits, `impl` organization, macros, and build-speed best practices. Automatically triggers when working on `.rs` files or projects with a `Cargo.toml`.
