# lean-agents: Is MCP reservation for `general-purpose` deliberate?

## Context

Question: should any of the larger lean-agents profiles (`main`, `standard-executor`,
`full-executor`) support MCP tools, or is MCP deliberately reserved for
`general-purpose` because pulling in MCP tool schemas inflates initial context/token
overhead. This is a design-confirmation question, not a feature request — no code
change is implicated unless a reversal is wanted after seeing the answer.

## Answer: it's deliberate, and it's already fully implemented

Checked all four agent definitions in `plugins/lean-agents/agents/` plus the plugin's
`CLAUDE.md` and git history:

- **Every one of the four profiles** (`lean-executor`, `standard-executor`, `main`,
  `full-executor`) sets **`disableMcp: true`** in its frontmatter. None of them can use
  MCP tools, regardless of tier — not even `full-executor`, which otherwise carries
  nearly the full built-in roster (31 tools: Cron*, Worktree, Monitor, Task family,
  NotebookEdit, etc.).
- `general-purpose` (Claude Code's built-in default agent) is the **only** rung on the
  ladder with MCP access. The plugin doesn't redefine it — it's referenced purely as
  the escalation backstop.
- The stated reason is exactly the token-cost hypothesis. `plugins/lean-agents/CLAUDE.md`:
  > "the parent's System-tools line (~42k tokens for the full default roster) is paid
  > on every sub-agent spawn that doesn't restrict its own toolset."

  > "Escalate directly to `general-purpose` only when the task visibly needs MCP from
  > the start; otherwise pay the cheaper agent first."
- `full-executor`'s own description makes the tiering explicit: it "Has `Agent` so it
  can escalate to `general-purpose` when MCP access is required. Carries more
  System-tools overhead than `standard-executor`" — i.e., even the richest lean profile
  is designed to hand off rather than absorb MCP.
- `git log`: `fa30e8e` (the plugin's introducing commit) documents the five-tier ladder
  (lean → standard → main → full → general-purpose) with MCP exclusive to the last
  tier. A later fix (`e338e6d`) touched only Glob/Grep escalation behavior and
  explicitly notes "No agent's `tools:` frontmatter changed" — the MCP boundary has
  never been revisited.

So: not an oversight — it's a load-bearing, documented invariant of the plugin's cost
model. Any MCP-needing task, at any tier, is expected to escalate to `general-purpose`
rather than have MCP added to an intermediate agent.

## Recommendation

No change needed. If there's interest in giving e.g. `full-executor` MCP access
(trading its lower avg. cost for fewer escalation hops on MCP-adjacent tasks), that
would be a deliberate reversal of a documented design decision and worth its own
follow-up conversation — flagged here rather than folded into this answer.

## Verification

N/A — this was a research/confirmation task, not a code change. The evidence above
(frontmatter `disableMcp: true` on all four agents, `CLAUDE.md` rationale, commit
`fa30e8e`) is directly inspectable in `plugins/lean-agents/`.
