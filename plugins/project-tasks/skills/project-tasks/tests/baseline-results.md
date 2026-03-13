# Baseline Test Results (Without Skill)

## Test 1: Logging a Task

**Input:** `fix: Log lines should never exceed one line`

**Failures observed:**
1. **Wrong format entirely** — Used `## Fix:` (capitalized) instead of `## fix:`
2. **No metadata line** — Missing `**Date:** ... | **Priority:** ... | **Tags:** ...` format
3. **No `---` separator** before entry
4. **Wrong status format** — Used `**Status:** Open` instead of `**Status:** pending`
5. **No `### Requirements` section** — Wrote a freeform "Description" and "Next Steps" instead
6. **No tri-modal choice** — Instead asked clarifying questions about the fix
7. **Added extra sections** — "Context", "Related Files", "Next Steps" not part of spec
8. **Did not create `# Tasks` header** — Used `# Tasks` but overall structure is wrong

**Key insight:** Without the skill, the agent invents its own format that's closer to a GitHub issue than our compact task format. It also doesn't know about the tri-modal execution choice at all.

## Test 2: Running a Task via Subagent

**Input:** `run task #1`

**Failures observed:**
1. **No tri-modal choice presented** — Jumped straight to analysis
2. **No worktree recommendation** — No consideration of git status or isolation
3. **Subagent context too broad** — Would send "Key Files to Investigate", "Definition of Done", and extra context beyond CLAUDE.md + README.md + requirements
4. **Wrong TASKS.md update format** — Used `**Status:** completed` (no timestamp) and added a non-spec "Completion Notes" section with "Changes" list
5. **No auto-update of CHANGELOG.md** — Not mentioned at all
6. **Extra metadata added** — Added "Completion Notes", "Changes" sections not in spec
7. **Did not use Agent tool** — Described what it would do rather than dispatching

**Key insight:** The agent provides far too much context to the subagent (defeating the minimal-context goal) and doesn't know the correct status format `completed (YYYY-MM-DD HH:MM)`.

## Test 3: Changelog Generation

**Input:** `Generate the changelog`

**Failures observed:**
1. **Wrong type headings** — Used `### Fixed` and `### Added` (Keep a Changelog convention) instead of `### Fixes`, `### Tasks`, `### Todos`
2. **Added boilerplate** — "All notable changes..." preamble not in spec
3. **Added `[Unreleased]` section** — Not in spec
4. **Added `---` separators between dates** — Not in spec
5. **Included task descriptions in bullets** — Added requirement details after title instead of just title + tags
6. **Wrong tag format** — Tags not shown in parentheses at all
7. **`task:` mapped to "Added"** — Should stay as "Tasks"

**Key insight:** The agent defaults to "Keep a Changelog" conventions rather than our custom format. Tags are completely lost and type mapping is wrong.

## Summary: What the Skill Must Teach

1. **Exact TASKS.md format** — heading, metadata line, status line, requirements section (with examples)
2. **Tri-modal execution choice** — Run Now / Log Only / Auto-Run All
3. **Minimal subagent context** — ONLY CLAUDE.md + README.md + task requirements
4. **Worktree recommendation** logic based on git status
5. **Exact status format** — `pending` / `completed (YYYY-MM-DD HH:MM)`
6. **Exact CHANGELOG.md format** — our custom format, not "Keep a Changelog"
7. **Prepend behavior** — newest tasks first
8. **Auto-update CHANGELOG.md** after task completion
9. **No extra sections** — no Description, Context, Related Files, Completion Notes
