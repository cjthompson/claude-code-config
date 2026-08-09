---
name: python-async-concurrency
description: Design, implement, and debug Python asyncio and concurrent code with structured concurrency, bounded parallelism, cancellation safety, timeouts, cleanup, and clear error propagation. Use for async workflows, task orchestration, or choosing among concurrency models.
---

# Python Async and Concurrency

## Select the model

- Use synchronous code when concurrency adds no material benefit.
- Use `asyncio` for many cooperating I/O operations whose libraries are async-aware.
- Use threads for blocking I/O that cannot be made async.
- Use processes or interpreters for CPU-bound work after measuring serialization and startup costs.

## Asyncio defaults

- Prefer `asyncio.TaskGroup` for child-task lifetimes and grouped failure propagation.
- Bound fan-out with a semaphore, queue, or worker pool; never create unbounded tasks from untrusted input.
- Put time limits at meaningful operation boundaries with `asyncio.timeout`.
- Let cancellation propagate. Catch `CancelledError` only for necessary cleanup, then re-raise it.
- Clean up files, sessions, locks, tasks, and subprocesses with context managers and `finally` blocks.
- Do not call blocking functions on the event-loop thread; offload unavoidable calls explicitly.

## Failure and verification

Define whether one failure cancels siblings, is collected, or is retried. Handle `ExceptionGroup` only at a boundary that can make that policy decision. Test success, partial failure, timeout, cancellation, bounded concurrency, and cleanup without relying on arbitrary sleeps.
