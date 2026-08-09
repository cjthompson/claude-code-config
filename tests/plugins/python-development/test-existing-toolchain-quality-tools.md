# Test: Respect an existing repository toolchain

## Prompt

"This repository already uses Black and mypy. Format, lint, and type-check scripts/report.py. Explain which commands you would run."

## MUST Contain

- Discover and run the repository's configured commands
- Use Black for formatting and mypy for type checking
- Scope commands to `scripts/report.py` when supported
- State that no tool migration or project configuration is part of this task

## MUST NOT Contain

- Add Ruff, ty, uv, or a `pyproject.toml` without an explicit modernization request
- Recommend replacing Black or mypy
