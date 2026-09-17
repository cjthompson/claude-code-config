---
description: Initialize the project-tasks plugin and load the skill
---

# Project Tasks Initialization

This is the canonical initialization procedure for the project-tasks commands
and skill. Run it once per invocation, before the first project-tasks
operation, then reuse the resolved values for later operations in that same
invocation. Run it again if the working directory, project, helper, or storage
directory changes. Resolve the project identifier when the requested operation
is project-scoped.

## Resolve the helper and storage directory

```bash
setopt sh_word_split 2>/dev/null || true

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required"
  exit 1
fi

if command -v task-db >/dev/null 2>&1; then
  TASK_DB="task-db"
else
  HELPER="${PROJECT_TASKS_DB_HELPER:-}"
  if [ -z "$HELPER" ]; then
    for candidate in \
      "plugins/project-tasks/bin/task-db" \
      "bin/task-db" \
      "../bin/task-db" \
      "../../bin/task-db"
    do
      if [ -f "$candidate" ]; then
        HELPER="$candidate"
        break
      fi
    done
  fi
  if [ -z "$HELPER" ]; then
    for root in "$HOME/.claude" "${CODEX_HOME:-$HOME/.codex}"; do
      [ -d "$root" ] || continue
      HELPER=$(find "$root" -type f -path "*/project-tasks/bin/task-db" -print -quit 2>/dev/null)
      [ -n "$HELPER" ] && break
    done
  fi
  if [ -z "$HELPER" ] && [ -f "$HOME/.claude/task-db.mjs" ]; then
    HELPER="$HOME/.claude/task-db.mjs"
  fi
  if [ -z "$HELPER" ] || [ ! -f "$HELPER" ]; then
    echo "ERROR: task-db helper not found"
    exit 1
  fi
  TASK_DB="node $HELPER"
fi

IS_CODEX_HOST=0
if [ -n "$CODEX_HOME" ] || [ -n "$CODEX_SANDBOX" ] || [ -n "$CODEX_THREAD_ID" ] || [ -n "$CODEX_CI" ]; then
  IS_CODEX_HOST=1
fi

PROJECT_TASKS_HOME_EXPLICIT=0
if [ -n "$PROJECT_TASKS_HOME" ]; then
  PROJECT_TASKS_HOME_EXPLICIT=1
  export PROJECT_TASKS_HOME
else
  unset PROJECT_TASKS_HOME
fi

if [ -z "$PROJECT_TASKS_CONFIG_DIR" ]; then
  if [ "$IS_CODEX_HOST" = "1" ]; then
    PROJECT_TASKS_CONFIG_DIR=".codex"
  else
    PROJECT_TASKS_CONFIG_DIR=".claude"
  fi
fi
export PROJECT_TASKS_CONFIG_DIR
```

`$TASK_DB` may contain two words on the fallback path, so use it unquoted. If
`node` or the helper is unavailable, report the problem and stop. If the host
lacks subagent, task-list, worktree, cancellation, or model-selection
capabilities, keep database commands available and report which execution
feature is unavailable. Do not invent tool calls.

When `PROJECT_TASKS_HOME` is not set, the helper uses one agent-neutral,
platform-native directory:

- macOS: `$HOME/Library/Application Support/project-tasks`
- Linux and other XDG systems:
  `${XDG_DATA_HOME:-$HOME/.local/share}/project-tasks`
- Windows: `%LOCALAPPDATA%\project-tasks`, falling back to
  `%APPDATA%\project-tasks`

Claude and Codex therefore use the same default database. Host detection above
only selects the preferred per-project config directory.

## Initialize the database

```bash
$TASK_DB db init
```

Handle exit `0` silently. Exit `2` means first-time setup; tell the user they
may allow the resolved helper invocation in their host's command allowlist to
avoid repeated prompts. For any other exit, show stderr and stop.

On exit `2`, when `PROJECT_TASKS_HOME_EXPLICIT=0`, check whether either legacy
default exists:

- `$HOME/.claude/tasks.db`
- `${CODEX_HOME:-$HOME/.codex}/project-tasks/tasks.db`

If one or both exist, report their exact paths and ask whether the user wants
to migrate them into the new shared store. Detection is read-only. Do not copy,
move, merge, delete, or directly query a legacy database before the user gives
explicit approval. If the user approves, use the supported migration workflow:
run its dry-run first, report the source, destination, backup, and proposed
record mappings, then obtain explicit approval immediately before its applying
step. `db migrate` only normalizes project identifiers inside one store; it is
not a cross-store import command. If no supported cross-store migration is
available, report that and stop. If the user declines, leave every legacy
database unchanged and continue with the newly initialized shared store.

## Resolve the project identifier

For a project-scoped operation, set the upward-search boundary to the Git root
when present, otherwise the filesystem root. Resolve `$PROJECT` in this order:

1. Walk from the cwd through the boundary directory. At each level check
   `$PROJECT_TASKS_CONFIG_DIR/project-tasks.json`, `.codex/project-tasks.json`,
   and `.claude/project-tasks.json`. Use the first nonempty trimmed
   `projectName`.
2. Otherwise normalize `git remote get-url origin` to `host/owner/repo` by
   converting the `git@host:` prefix, removing an HTTP(S) prefix, and removing
   a trailing `.git` and slash.
3. Otherwise, only inside a Git repository, use the Git top-level basename.
4. If still empty, ask the user for a project name. Never use the cwd basename
   outside a Git repository.

The upward walk must stop after checking the boundary itself so it cannot adopt
an unrelated parent repository's config.

When the user supplies a project name, offer exactly:

```text
a) Yes, create and stage for commit
b) Yes, create but don't commit
c) No, use the name for this session
```

For (a) or (b), create
`$PROJECT_TASKS_CONFIG_DIR/project-tasks.json` at the Git root, or the cwd when
there is no Git root, containing a `projectName` field. For (a), stage only
that file. Never commit it automatically.

## Slash-command completion

When invoked as `/project-tasks:init`, load the `project-tasks` skill after
successful database initialization, then confirm in one short sentence that
the plugin is initialized and the skill is loaded. When the skill routed here
during another request, return to that request instead of loading the skill
again.
