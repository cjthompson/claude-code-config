## Worktree rule (worktree-guard plugin)

Always work in a git worktree unless the user explicitly opts out.

- Before editing files in a git repository, make sure they are in a linked
  worktree, not the main checkout. Detect with:
  `[ "$(git rev-parse --path-format=absolute --git-common-dir)" != "$(git rev-parse --path-format=absolute --git-dir)" ]`
  — equal means main checkout.
- The worktree-guard `PreToolUse` hook gates any file edit whose target is in
  a main checkout:
  - Claude Code (`Edit`, `Write`, `NotebookEdit`): an `ask` permission prompt.
  - Codex (`apply_patch`): the edit is denied, because Codex hooks cannot
    prompt.
  Treat either as the cue to create a worktree (`git worktree add
  ../<branch>`) and edit there instead.
- Bypass phrases ("edit main directly", "skip the worktree rule", "no
  worktree needed", "stay in main"): when the user says one, proceed — in
  Claude Code they approve the `ask` prompt. In Codex, a denied edit can only
  proceed if the user relaunched with `WORKTREE_GUARD_DISABLE=1`; tell them
  so rather than working around the hook. Never use a bypass phrase on the
  user's behalf.
- Shell-based writes (`sed -i`, redirects) are not intercepted; the rule
  still applies to them, and must not be used to get around a denied edit.
- Subagents follow the same rule. Spawn them with a worktree path or from
  inside the worktree. A subagent that finds itself about to edit the main
  checkout must stop and use a worktree first.
