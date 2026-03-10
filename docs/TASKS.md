# Tasks

---

## task: change "todo: " to always "Log Only"
**Date:** 2026-03-09 14:00 | **Priority:** medium | **Tags:** —
**Status:** pending

### Requirements
- In the project-tasks SKILL.md, update the "Logging a Task" section so that the `todo:` prefix skips the execution choice prompt entirely and always behaves as "Log Only" (task is saved as `pending` with no dispatch)
- Update any documentation or quick reference that implies `todo:` has the same behavior as `task:`

---

## task: Add CLAUDE.md with post-commit changelog and version update instructions
**Date:** 2026-03-09 12:00 | **Priority:** medium | **Tags:** #workflow
**Status:** completed (2026-03-09 12:01)

### Requirements
- Create a `CLAUDE.md` at the project root with instructions for Claude to always update `docs/CHANGELOG.md` after committing new changes
- Include an instruction to do a patch version bump in `package.json` after each commit
