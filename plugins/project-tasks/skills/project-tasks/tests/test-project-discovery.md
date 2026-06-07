# Test: Project Identifier Discovery

The skill derives a `$PROJECT` string that keys into the SQLite task list. The discovery algorithm in the Prerequisites section (step 3) has three tiers:

1. Walk up from cwd looking for `.claude/project-tasks.json`. If found, use its `projectName`.
2. Otherwise, use `git remote get-url origin` (with `.git` stripped).
3. Otherwise, use `basename` of the git toplevel.

If all three tiers return empty, the skill must prompt the user.

---

## Variant 1: Project with `.claude/project-tasks.json` committed

### Setup

A git repo with the following committed file at the project root:

**`.claude/project-tasks.json`**
```json
{
  "projectName": "github.com/acme/widget"
}
```

The git remote is also set (to a different URL) to verify Tier 1 wins over Tier 2:
```bash
git remote add origin "git@github.com:different/url.git"
```

### Scenario

The user issues a `task:` command from the project root. The skill runs the prerequisite `$PROJECT` derivation.

### Expected Behavior

1. The walk-up loop finds `.claude/project-tasks.json` at the project root.
2. `PROJECT` is set to `github.com/acme/widget` (the file's value, NOT the git remote URL).
3. The Tier 2 fallback is NOT used.
4. No onboarding prompt is shown.

### Failure Criteria

- **FAIL** if `$PROJECT` is the git remote URL (Tier 2) instead of the file's `projectName`.
- **FAIL** if the walk-up loop errors out and falls through without finding the file.
- **FAIL** if the file is found but the JSON is not parsed (e.g. `node -e` errors are not redirected to `/dev/null`).
- **FAIL** if `$PROJECT` is empty when the file exists with a valid `projectName`.

---

## Variant 2: Nested subdirectory, file at project root

### Setup

Same as Variant 1, but the user is in a nested subdirectory:
```
/project-root/.claude/project-tasks.json
/project-root/packages/inner/   ← cwd
```

### Scenario

The user issues a `task:` command from `packages/inner/`.

### Expected Behavior

1. The walk-up loop checks `/project-root/packages/inner/.claude/project-tasks.json` (not found), then `/project-root/packages/.claude/project-tasks.json` (not found), then `/project-root/.claude/project-tasks.json` (found).
2. `PROJECT` is set to `github.com/acme/widget`.

### Failure Criteria

- **FAIL** if the walk-up only checks the cwd and not parent directories.
- **FAIL** if the walk-up stops at the first directory without checking for the file.

---

## Variant 3: Project without `.claude/project-tasks.json`, but with a git remote

### Setup

A git repo with a remote but no `.claude/project-tasks.json` file at any level.

### Scenario

The user issues a `task:` command.

### Expected Behavior

1. The walk-up loop runs without finding a `.claude/project-tasks.json` file.
2. Tier 2 fires: `PROJECT` is set to the git remote URL with `.git` stripped.
3. No onboarding prompt is shown (Tier 2 succeeded).

### Failure Criteria

- **FAIL** if Tier 2 doesn't strip the `.git` suffix from the URL.
- **FAIL** if the walk-up doesn't terminate and reaches `/` without success.
- **FAIL** if the onboarding prompt is shown when Tier 2 would have succeeded.

---

## Variant 4: No project file, no git remote — onboarding prompt

### Setup

A directory with no `.claude/project-tasks.json` anywhere in the tree, AND no git repo (so `git remote get-url origin` and `git rev-parse --show-toplevel` both fail).

### Scenario

The user issues a `task:` command.

### Expected Behavior

1. All three tiers return empty.
2. The skill uses AskUserQuestion to prompt the user for a project name.
3. After the user picks a name and chooses to create the file, the skill writes `.claude/project-tasks.json` at the project toplevel (or, in a no-git scenario, at a sensible location — e.g. cwd's `.claude/`).
4. The user's chosen name is used as `$PROJECT` for the rest of the session.
5. The skill does NOT silently fall back to a directory basename and proceed — that would re-introduce the fragmentation problem this mechanism exists to prevent.

### Failure Criteria

- **FAIL** if the skill uses a directory basename silently when all three tiers fail (the original behavior — explicitly disallowed).
- **FAIL** if no prompt is shown and `$PROJECT` is empty for the rest of the session.
- **FAIL** if the prompt doesn't offer to create the file.
- **FAIL** if the file is created with malformed JSON.
- **FAIL** if `node` is invoked to read the file but errors are not suppressed (a missing/malformed file should not abort the whole walk-up).
