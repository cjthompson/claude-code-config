---
name: python-typing
description: Use when writing or editing typed Python scripts, parsing untyped input, choosing lightweight data shapes, or resolving common checker errors without project-scale type-system research.
---

# Python Typing

Make untyped boundaries narrow and typed internals boring.

## Establish the target

- Follow the project's minimum Python version before choosing annotation
  syntax or imports from `typing`.
- Type every function parameter and return value, including `-> None`.
- Annotate empty containers, mutable state, and values crossing an untyped
  library boundary when inference is ambiguous.

## Type the boundary first

- Treat JSON, plist data, environment values, and other untrusted input as
  `object`, then narrow with `isinstance`. Untrusted does not mean `Any`.
- Validate container shape and each required value before constructing the
  typed internal representation.
- Remember that `bool` is an `int` subclass: reject it explicitly when a true
  integer is required.
- Parse CLI and text inputs at the edge. Pass typed values into the script's
  working functions.

```python
def require_count(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("count must be an integer")
    return value
```

## Pick the smallest useful model

- Use `TypedDict` when validated data must remain dictionary-shaped, such as a
  JSON record.
- Use a frozen dataclass for an internal value object with behavior or useful
  construction semantics.
- Use `Literal` or an enum for a genuinely closed set of values; otherwise use
  `str` plus validation.
- Do not add Pydantic or another runtime model dependency to a small script
  unless runtime schema features justify it.

## Make relationships honest

- Use `T | None` only when absence is valid, and narrow it before use.
- Prefer precise concrete types inside the implementation. At call boundaries,
  accept `Sequence`, `Mapping`, `Iterable`, or `Callable` when callers benefit
  and the function requires only that behavior.
- Type callbacks with their real parameters and result rather than `Callable`
  without arguments.
- Add `Protocol`, overloads, generics, type guards, or `Self` only when the
  implementation establishes the relationship they express.
- Let inference handle obvious local values; annotations should communicate or
  constrain, not repeat every literal.

## Deal with uncertainty visibly

- Avoid `cast()`, broad unions, `Any`, and `# type: ignore` as ways to silence a
  checker. Prefer validation, narrowing, or a small typed adapter.
- If a dependency is genuinely untyped, contain `Any` in one adapter and return
  a validated precise type from it.
- If an ignore is unavoidable, use the narrow error code supported by the
  configured checker and explain the external limitation.

Run the configured checker after editing and fix the source rather than merely
reducing the error count.

If the runtime lists `python-development:python-typing-reference`, invoke it
for difficult semantics. If it lists `python-development:tighten-python-types`,
invoke that skill for systematic cross-file typing edits. Otherwise continue
with these rules and state the unavailable escalation only when it matters.
