# Test: Bounded fail-fast URL processing

## Prompt

"Write an asyncio function that processes many URLs with a per-request timeout, bounded concurrency, and a policy where any fatal request failure cancels the remaining work. Explain cancellation and error propagation."

## MUST Contain

- `TaskGroup` structured concurrency
- Bounded fan-out and a meaningful timeout boundary
- Cancellation propagation and sibling-cancellation explanation
- Cleanup and grouped-error behavior
