---
name: python-project-tooling
description: Configure and maintain Python projects, dependencies, packaging, environments, linting, formatting, type checking, testing, builds, and publishing. Use for pyproject.toml or repository-level Python tooling work, not for a one-off script.
---

# Python Project Tooling

## Respect established projects

Inspect `pyproject.toml`, lockfiles, CI, contributor docs, and existing commands. Continue using configured tools silently. Do not introduce uv, Ruff, ty, pytest, or a new build backend merely to replace working equivalents unless the user requests a migration.

## New or deliberately modernized projects

1. Ask for the supported Python version when it is not specified; offer Python 3.14 as the default.
2. Prefer uv for environments, dependencies, locking, and command execution.
3. Prefer Ruff for formatting and linting, ty for static type checking, and pytest for tests.
4. Put canonical configuration in `pyproject.toml`; keep CI and contributor commands aligned with it.
5. Choose a build backend appropriate to the package. Do not add packaging machinery to an application that is not distributed.
6. Commit a lockfile when reproducibility is part of the repository's policy.

## Change safely

- Separate a tool migration from unrelated feature work.
- Pin only where reproducibility or compatibility requires it; preserve useful lower and upper bounds.
- Verify lock consistency, clean-environment installation, lint, format check, type check, tests, and package build as applicable.
- For publishing, prefer trusted publishing and a dry run or test index before a production release.
