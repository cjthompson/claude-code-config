---
name: dignified-python
description: Apply opinionated, production-grade Python design and review standards. Use for substantial Python implementation, refactoring, API design, module design, exception boundaries, interfaces, or a deep code-quality review; not for a quick standalone script.
---

# Dignified Python

Use this skill for sustained Python engineering where design quality matters. Preserve an existing repository's conventions unless the user explicitly asks to modernize them.

## Establish the target

1. Read the repository instructions and existing Python configuration.
2. Determine the minimum Python version from `requires-python`, `python_requires`, `.python-version`, CI, or equivalent evidence.
3. If no target is declared, ask the user. Offer Python 3.14 as the default for new work; do not silently choose a version.
4. Read `dignified-python-core.md`, then the matching `versions/python-3.x.md` file.

## Work deliberately

- Model domain data explicitly and keep invalid states hard to represent.
- Use precise annotations at public boundaries; avoid `Any` unless an untyped boundary truly requires it.
- Prefer small cohesive modules, explicit dependencies, `pathlib`, deterministic cleanup, and actionable errors.
- Follow the project's established test, lint, format, type-check, build, and dependency commands.
- Make the narrowest change that solves the request. Avoid opportunistic migrations.

## Load references only when needed

- CLI work: `cli-patterns.md`
- Subprocess work: `subprocess.md`
- API signatures: `references/advanced/api-design.md`
- Exception boundaries: `references/advanced/exception-handling.md`
- ABC versus Protocol: `references/advanced/interfaces.md`
- Casts, literals, and narrowing: `references/advanced/typing-advanced.md`
- Module structure and import-time behavior: `references/module-design.md`
- Final deep review: `references/checklists.md`

For normative typing questions, hand off to `python-development:python-typing-reference`. For a focused annotation-tightening pass, use `python-development:tighten-python-types`. For tests, tooling, or concurrency, use the corresponding specialized skill in this plugin.
