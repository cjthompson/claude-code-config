---
name: python-quality-tools
description: Use when formatting, linting, or type-checking Python files without creating or redesigning a Python project, especially for standalone scripts or repositories with an established toolchain.
---

# Python Quality Tools

Check the requested files without changing the project's tool strategy.

1. Inspect `pyproject.toml`, lockfiles, task runners, and CI to find the exact
   configured commands. Use them silently; do not recommend migration. If the
   requested check has no configured tool, report that gap instead of adding a
   tool or pretending another command covers it.
2. If no project tools exist and the target is a standalone file, use:

   ```bash
   uvx ruff format path/to/script.py
   uvx ruff check --fix path/to/script.py
   uvx ty check path/to/script.py
   ```

3. Review formatter changes, then re-run lint without `--fix` and run the type
   checker again for clean evidence.
4. Do not create `pyproject.toml`, a package layout, a lockfile, or a virtual
   environment for this workflow.

If configuration, dependency management, migration, builds, or publishing are
requested and `python-development:python-project-tooling` is available, invoke
that skill. Otherwise keep the task file-scoped.
