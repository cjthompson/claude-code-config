# Test: Project Identifier Discovery

The canonical algorithm is `commands/init.md` under **Resolve the project
identifier**. It resolves `$PROJECT` in four ordered steps:

1. Walk from cwd through the Git-root boundary (or filesystem root outside
   Git). At each level, check
   `$PROJECT_TASKS_CONFIG_DIR/project-tasks.json`,
   `.codex/project-tasks.json`, and `.claude/project-tasks.json`; use the first
   nonempty `projectName`.
2. Otherwise normalize `git remote get-url origin` to `host/owner/repo`.
3. Otherwise, only inside a Git repository, use the Git top-level basename.
4. Otherwise prompt for a project name and offer to create the config.

The walk checks the boundary directory itself, then stops. It must not adopt a
config from a directory above the current Git repository.

For any scenario that proceeds to a task command, create and export the
isolated store before running `commands/init.md` or any helper command:

```bash
TEST_PROJECT_TASKS_HOME=$(mktemp -d "${TMPDIR:-/tmp}/project-tasks-discovery.XXXXXX")
export PROJECT_TASKS_HOME="$TEST_PROJECT_TASKS_HOME"
```

Then run the canonical initialization in `commands/init.md`; its database
initialization must use this exported temporary store.

Never use the default Claude/Codex task store or create a database in the
worktree. Clean up only the exact directory returned by `mktemp`.

---

## Variant 1: Config at the project root

### Setup

A Git repository contains `.claude/project-tasks.json`:

```json
{
  "projectName": "github.com/acme/widget"
}
```

Its origin is deliberately different:

```bash
git remote add origin "git@github.com:different/url.git"
```

### Expected behavior

1. The config walk finds the file at the Git root.
2. `$PROJECT` is `github.com/acme/widget`.
3. The origin fallback is not used and onboarding is not shown.

### Failure criteria

- **FAIL** if the origin wins over the nonempty configured `projectName`.
- **FAIL** if a valid config is ignored or `$PROJECT` remains empty.

---

## Variant 2: Host-selected config directory in a nested checkout path

### Setup

The cwd is `/project-root/packages/inner`. The Git root contains
`$PROJECT_TASKS_CONFIG_DIR/project-tasks.json`; for a Codex-host example,
`PROJECT_TASKS_CONFIG_DIR=.codex`.

### Expected behavior

1. The walk checks the cwd and each parent through `/project-root`.
2. It checks the host-selected path plus `.codex` and `.claude` at each level.
3. It uses the Git-root file's nonempty `projectName`.

### Failure criteria

- **FAIL** if only the cwd is checked.
- **FAIL** if `.codex` or the host-selected config directory is ignored.
- **FAIL** if the Git root itself is not checked.

---

## Variant 3: No config, origin available

### Setup

A Git repository has no project config and origin
`git@github.com:acme/widget.git`.

### Expected behavior

1. The bounded config walk finds nothing.
2. `$PROJECT` becomes `github.com/acme/widget` after SSH-prefix and trailing
   `.git` normalization.
3. The basename and onboarding fallbacks are not used.

### Failure criteria

- **FAIL** if the normalized key retains the SSH prefix, `.git`, or a trailing
  slash.
- **FAIL** if onboarding is shown despite a usable origin.

---

## Variant 4: No config or origin, but inside Git

### Setup

The Git top-level directory is `/work/widget`, with no project config and no
origin.

### Expected behavior

`$PROJECT` becomes `widget`. This basename fallback is allowed only because a
Git top-level directory exists.

### Failure criteria

- **FAIL** if the Git-root basename is not used.
- **FAIL** if an arbitrary cwd basename is used instead.

---

## Variant 5: Outside Git with no config

### Setup

The cwd is not inside a Git repository and no project config is found through
the filesystem-root boundary.

### Expected behavior

1. The first three resolution steps return empty.
2. The skill prompts through the current host's user-input mechanism.
3. It offers exactly:

   ```text
   a) Yes, create and stage for commit
   b) Yes, create but don't commit
   c) No, use the name for this session
   ```

4. For (a) or (b), it writes valid JSON under
   `$PROJECT_TASKS_CONFIG_DIR/project-tasks.json` at the cwd. It stages only
   that file for (a) and never commits automatically.
5. It uses the chosen name for the session.

### Failure criteria

- **FAIL** if an arbitrary directory basename is silently selected.
- **FAIL** if no project name is requested.
- **FAIL** if the creation choices differ or the resulting JSON is invalid.
- **FAIL** if the file is committed automatically.

---

## Variant 6: Parent config above the Git-root boundary

### Setup

`/parent/.claude/project-tasks.json` names `wrong-parent`, while
`/parent/child-repo` is a Git root with no config and origin
`git@github.com:acme/child.git`. The cwd is
`/parent/child-repo/packages/inner`.

### Expected behavior

1. The config walk checks through `/parent/child-repo` and stops.
2. It does not read `/parent/.claude/project-tasks.json`.
3. `$PROJECT` resolves from the child repository origin as
   `github.com/acme/child`.

### Failure criteria

- **FAIL** if the walk crosses the Git-root boundary.
- **FAIL** if `$PROJECT` becomes `wrong-parent`.
