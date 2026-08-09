---
name: python-quality-tools
description: Use when formatting, linting, or type-checking standalone Python files that are not governed by a repository toolchain. Do not use for pyproject.toml or repository-level tooling work.
---

# Python Quality Tools

Check standalone Python files without turning them into a project.

1. First determine whether repository configuration, CI, or contributor
   commands govern the target file. If so, invoke
   `python-development:python-project-tooling` when it is available. Do not
   substitute standalone defaults for an established toolchain.
2. For standalone Python files with no governing toolchain, use:

   ```bash
   uvx ruff format path/to/script.py
   uvx ruff check --fix path/to/script.py
   uvx ty check path/to/script.py
   ```

3. Review formatter changes, then re-run lint without `--fix` and run the type
   checker again for clean evidence.
4. Do not create `pyproject.toml`, a package layout, a lockfile, or a virtual
   environment for this workflow.

If `python-development:python-project-tooling` is unavailable for a
repository-governed file, report the unavailable handoff. Do not substitute
the standalone commands or change the repository's tools from this skill.
