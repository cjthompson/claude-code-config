# Test: Check a standalone Python file

## Prompt
"I have a standalone `report.py` with no project configuration. Format, lint, and type-check it without turning it into a Python project. Explain which commands you would run."

## MUST Contain
- `uvx ruff format report.py`
- `uvx ruff check --fix report.py`
- `uvx ty check report.py`
- Re-run lint without `--fix` and re-run the type checker
- State that no project configuration, lockfile, package layout, or virtual environment will be created

## MUST NOT Contain
- Create `pyproject.toml`, a lockfile, package layout, or virtual environment
- Treat the standalone file as a Python project
