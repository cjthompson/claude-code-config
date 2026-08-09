---
name: python-coding
description: Use when creating or editing ordinary Python scripts and modules, especially when the target Python version or repository conventions must be resolved before coding.
---

# Python Coding

Keep routine Python readable, typed, and small.

1. Inspect `pyproject.toml` (`requires-python`), `setup.cfg`, `setup.py`, then
   `.python-version` for the minimum Python version. If none declares it, ask
   the user and offer Python 3.14 as the default. For Apple system-Python work,
   use `macos-python-scripting` instead.
2. Preserve existing layout, dependencies, commands, and style.
3. Type public and internal function signatures, including `-> None`. Keep
   boundary parsing separate from typed internal logic.
4. Prefer `pathlib`, context managers, explicit error messages, and standard
   library APIs. Add dependencies only when their value exceeds their setup
   cost.
5. Put executable work in `main()` and use a module guard. Keep imports free of
   I/O and other side effects.
6. Verify the narrowest relevant behavior, then run the repository's existing
   formatter, linter, type checker, and tests when configured.

Use `python-typing` for nontrivial data shapes and `python-quality-tools` for a
standalone check. Do not load project-scale guidance for a small script.
