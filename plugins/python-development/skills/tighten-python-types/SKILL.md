---
name: tighten-python-types
description: Tighten annotations in existing Python code with a focused, low-churn workflow based on Honnibal's tighten-types skill. Use to improve changed files, remove avoidable Any, make container and return types precise, or reduce type-checker errors without broad refactoring.
---

# Tighten Python Types

Read the pinned upstream workflow at `../../vendor/tighten-types/tighten-types.md.txt` before acting. Apply it in the current repository's context with these constraints:

- Default to Python files already changed for the user's task. Expand scope only when required by their interfaces or explicitly requested.
- Determine the supported Python version and configured type checker before choosing syntax or commands.
- Preserve runtime behavior and public compatibility. Avoid unrelated refactors, formatting churn, and blanket ignores.
- Replace broad `Any`, unparameterized containers, and ambiguous optionality with the narrowest honest types supported by evidence.
- Prefer natural narrowing, typed boundaries, protocols, and small helpers over `cast`; use `cast` only when runtime facts cannot be expressed otherwise.
- Do not invent types for dynamic or untrusted data. Validate it, model it explicitly, or keep the uncertainty visible at the boundary.
- Run the repository's formatter, linter, type checker, and focused tests. Report remaining errors and any annotations intentionally left broad.

For a disputed type-system rule, hand off to `python-development:python-typing-reference`.
