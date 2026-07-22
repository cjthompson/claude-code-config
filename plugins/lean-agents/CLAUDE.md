# Sub-agent routing rules

When delegating a task to a sub-agent via the Agent tool, pick by tool need, not by default — the parent's System-tools line (~42k tokens for the full default roster) is paid on every sub-agent spawn that doesn't restrict its own toolset. Each agent's `description:` field includes its tool roster for comparison.

Escalation ladder (cheapest → most expensive):

1. **`lean-executor`** — Bash, Edit, EnterWorktree, ExitWorktree, Read, Write. Tight parallel fan-out where each worker needs file I/O + shell + worktree isolation only. No skills, no spawning, no network, no MCP. Smallest possible toolset.
2. **`standard-executor`** — Bash, Edit, Read, Write, WebFetch, WebSearch, Skill, **Agent**. Everyday workhorse. Adds skill invocation and self-escalation. ~7–9k System-tools tokens. No Cron/Worktree/Monitor/Task family/MCP.
3. **`main`** — Agent, AskUserQuestion, Bash, Edit, Glob, Grep, LSP, Read, Skill, WebFetch, WebSearch, Write. Interactive profile: adds Glob/Grep/LSP/AskUserQuestion so the agent can plan, explore code, and ask clarifying questions. ~14–18k System-tools tokens. No Cron/Worktree/Monitor/Task family/MCP.
4. **`full-executor`** — Everything in `main` plus CronCreate/Delete/List, NotebookEdit, EnterPlanMode, EnterWorktree/ExitWorktree, ExitPlanMode, Monitor, PushNotification, ReportFindings, RemoteTrigger, ScheduleWakeup, the Task family. ~30–40k System-tools tokens. No MCP.
5. **`general-purpose`** — Full default roster including MCP tools. Backstop when nothing else fits.

Rules:

- Default to `standard-executor` for any sub-agent task that doesn't obviously need the rare tools. Use `lean-executor` when no skill or Agent spawning is needed.
- **Pick by the sub-task's tool need, not the parent's toolset.** If the sub-task needs no tools at all (pure reasoning, computation, translation), spawn `lean-executor`. If the sub-task needs only the common tools, do it inline in `standard-executor` instead of spawning another agent.
- If a `standard-executor` or `main` reports a tool gap, escalate to `full-executor` (rare tools) or `general-purpose` (MCP). `standard-executor` can self-escalate on its own — let it.
- Escalate directly to `general-purpose` only when the task visibly needs MCP from the start; otherwise pay the cheaper agent first.

To make `main` the default main-thread agent for bare `claude` sessions, add `"agent": "main"` to user-level settings. (Not shipped automatically to avoid changing existing user setups.)