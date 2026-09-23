# Simple commit message for the squash merge

## Context

`HEAD` (70d1a79) on `main` is already a squash commit combining 4 commits
that iteratively tightened the Terse output style (`plugins/output-styles/output-styles/terse.md`):
closing wording gaps, two rounds of review fixes, and a version/changelog bump.
Git's default squash message is the full commit-log dump. The user wants a
short, single-purpose message to replace it instead.

Trivial text task — no code exploration/design agents needed.

## Recommended commit message

```
fix(output-styles): close wording gaps in the Terse style rules

Iterates on Terse per review findings so rules can't be satisfied by
output that violates their intent (missing Result block, unexpanded
acronyms, escapable colon/dash ban, etc).
```

Squash merge here is amend-only — applying it is just
`git commit --amend -m "..."`, no separate step needed.

## Verification

N/A — text-only deliverable, no code changed.
