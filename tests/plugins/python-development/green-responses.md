# python-development GREEN Responses

Generated with `gpt-5.6-luna` after reading the corresponding skill and selected references.

## Dignified production design

First ask which Python versions the service must support and offer 3.14 for new work; do not silently select an older version. Also resolve runtime/deployment boundaries, API and compatibility contracts, domain invariants and persistence, error semantics, and repository tooling. Inspect and preserve repository conventions before prescribing structure. After the target is chosen, read `dignified-python-core.md` and its matching version file. Consult `references/advanced/api-design.md` only while defining public signatures and `references/advanced/exception-handling.md` only while defining error boundaries. Then propose explicit domain models, precise public annotations, cohesive modules, explicit dependencies, and a verification plan aligned with actual tooling.

## Python testing

Unit-test valid records, normalization, defaults, deterministic serialization, validation boundaries, empty data, malformed JSON, invalid UTF-8, non-object JSON, missing/null/wrong fields, mixed valid and invalid records, actionable line-numbered errors, and rejection without partial output. Integration tests should invoke the real entry point with `tmp_path` and assert output, errors, counts, exit status, ordering, file creation/overwrite, final newline, and failure atomicity. Use Hypothesis only if permitted and the behavior is naturally invariant-shaped; useful properties include schema-valid output, no loss or duplication, idempotent normalization, determinism, and streaming equivalence. Do not mock JSON parsing, validation, normalization, serialization, or the filesystem seam; fake only slow, nondeterministic external boundaries.

## Python project tooling

First ask which Python versions the library supports and offer Python 3.14 if unconstrained. For this new project, propose uv for environments/dependencies/locking, Ruff for formatting and linting, ty for type checking, pytest for tests, canonical `pyproject.toml` configuration, a `src` layout with `py.typed`, and Hatchling unless specialized build hooks require another backend. CI should run format, lint, types, tests across the supported matrix, plus clean-environment build/install and metadata checks. Publish with PyPI trusted publishing and a test-index or dry run first. These are new-project defaults; an established project's working toolchain would be preserved unless migration were requested.

## Async concurrency

```python
import asyncio
from collections.abc import Awaitable, Callable, Iterable
from typing import TypeVar

T = TypeVar("T")
_STOP = object()


class FatalRequestError(RuntimeError):
    pass


async def process_urls(
    urls: Iterable[str],
    fetch: Callable[[str], Awaitable[T]],
    *,
    concurrency: int = 32,
    timeout_seconds: float = 10.0,
) -> dict[str, T]:
    if concurrency < 1:
        raise ValueError("concurrency must be positive")
    queue: asyncio.Queue[object] = asyncio.Queue(maxsize=concurrency * 2)
    results: dict[str, T] = {}

    async def producer() -> None:
        for url in urls:
            await queue.put(url)
        for _ in range(concurrency):
            await queue.put(_STOP)

    async def worker() -> None:
        while True:
            item = await queue.get()
            try:
                if item is _STOP:
                    return
                if not isinstance(item, str):
                    raise RuntimeError("invalid queue item")
                url = item
                try:
                    async with asyncio.timeout(timeout_seconds):
                        value = await fetch(url)
                except asyncio.CancelledError:
                    raise
                except TimeoutError as error:
                    raise FatalRequestError(f"request timed out: {url}") from error
                except Exception as error:
                    raise FatalRequestError(f"request failed: {url}") from error
                results[url] = value
            finally:
                queue.task_done()

    async with asyncio.TaskGroup() as group:
        group.create_task(producer())
        for _ in range(concurrency):
            group.create_task(worker())
    return results
```

The fixed worker pool and bounded queue prevent unbounded fan-out. The timeout covers the request rather than queue wait. A fatal worker exception makes `TaskGroup` cancel its siblings; workers propagate `CancelledError`, clean up queue accounting in `finally`, and the caller receives an `ExceptionGroup`, which it can handle with `except* FatalRequestError`.

## Typing variance reference

The vendored `concepts.rst` and `glossary.rst` define assignability, while `generics.rst` and `class-compat.rst` provide the relevant variance rules. `list[int]` is not assignable to `list[object]` because `list` is invariant: a receiver of `list[object]` could append a string and violate the original `list[int]`. `Sequence[int]` is assignable to `Sequence[object]` because the read-only interface is covariant. An API that only reads should normally accept `Sequence[T]`; require `list[T]` only for mutation or the concrete list contract. This is the normative specification rule, separate from checker-specific diagnostics or extensions.

## Tighten Python types

Read the pinned upstream workflow, inspect the diff and surrounding flow in the three changed files, discover the supported Python version and configured checker, and find the repository's existing quality commands. Classify each `Any` as a concrete library type, structured data suited to `TypedDict`, a boundary requiring validation or a Protocol, or genuinely unknown data that should remain visibly broad. Change only the three files and necessary interfaces, using natural narrowing and small helpers before `cast`. Preserve runtime behavior and compatibility; avoid unrelated models, public-signature changes, blanket ignores, and untouched-file modernization. Run the configured formatter, linter, type checker, and focused tests, compare with the baseline, and report intentionally retained broad boundaries.
