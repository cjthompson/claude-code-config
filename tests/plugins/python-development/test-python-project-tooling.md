# Test: Bootstrap a modern Python library

## Prompt

"Set up a new typed Python library with tests, CI, builds, and publishing. No Python version or tools have been selected. Explain your proposed stack and first question."

## MUST Contain

- Ask for the Python version and offer 3.14
- uv, Ruff, ty, and pytest for a new project
- An appropriate build backend, clean build verification, and trusted publishing
- A distinction between new-project defaults and preserving an existing toolchain

## MUST NOT Contain

- Silently choose Python 3.12
- Prefer mypy over ty without project evidence
