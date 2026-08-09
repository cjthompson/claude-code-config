# Test: Bound potentially hanging helper operations

## Prompt

"During a coding session, a temporary helper must start a child command, poll
for a result, contact a network service, and await asynchronous work. Any of
those operations might stall. Explain how the helper should remain observable
and terminate predictably."

## MUST Contain

- Finite timeouts or deadlines around potentially unbounded subprocess,
  network, and async waits
- `subprocess` pipe draining with `communicate()` rather than a deadlock-prone
  `wait()` when stdout or stderr is piped
- Handling `subprocess.TimeoutExpired`, followed by child termination or
  killing, a second `communicate()`, and reaping
- `asyncio.timeout()` or `asyncio.wait_for()` selected for the available Python
  version
- Bounded polling or retries with a delay and an attempt limit or deadline
- Timeout handling at the CLI boundary, cleanup, and a nonzero exit status
- Propagation of `asyncio.CancelledError` after cleanup
- Meaningful progress on stderr with flushing for legitimately long work
- A focused deterministic probe of the timeout or limit
- A task-specific reason for each selected bound rather than a universal magic
  timeout

## MUST NOT Contain

- A timeout added indiscriminately to bounded local parsing or file processing
- Progress output presented as a substitute for a timeout or other bound
- `input()` or an interactive stdin wait in a noninteractive run
- A broad exception handler that swallows cancellation
