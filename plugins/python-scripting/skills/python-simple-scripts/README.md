# Simple Python Scripts: Rule Rationale

This README records the reasoning behind selected rules in `SKILL.md`. It is
design documentation, not additional runtime instruction; `SKILL.md` remains
the normative skill.

The rules below are conditional. They do not require a helper to create
temporary files, expose CLI flags, or use assertions. They apply only when the
helper already uses the corresponding feature.

## Do not use predictable temporary filenames

A fixed shared path such as `/tmp/report.json` or `/tmp/helper.py` can collide
with another process or agent, reuse stale data, overwrite an unrelated file,
or follow a pre-existing symlink. A check-then-create sequence also permits
another process to claim the name between those operations.

Use a securely created task-specific directory or Python's `tempfile` APIs for
temporary data in a shared directory. Do not use `tempfile.mktemp()`, which the
Python documentation deprecates because of this race. A deliberate filename
inside an already isolated, task-specific directory is acceptable.

Reference: [Python `tempfile` documentation](https://docs.python.org/3/library/tempfile.html)

## Do not use `type=bool` for CLI flags

`argparse` applies the supplied converter to text. Because every nonempty
string is truthy, both `bool("False")` and `bool("0")` evaluate to `True`. Code
such as this therefore accepts a plausible command while silently producing
the opposite of the user's intent:

```python
parser.add_argument("--verbose", type=bool)
```

Use `action="store_true"`, `action="store_false"`, or
`argparse.BooleanOptionalAction`. If a command genuinely needs explicit text
values, use a strict converter that recognizes a documented set of tokens and
rejects everything else.

Reference: [Python `argparse` type documentation](https://docs.python.org/3/library/argparse.html#type)

## Do not rely solely on `assert`

Assertions are debugging checks. Python removes `assert` statements when it is
run with `-O` or when optimization is enabled through `PYTHONOPTIMIZE`. A helper
that uses assertions as its only input validation or result verification can
therefore stop checking correctness without changing its source.

Assertions remain appropriate as supplemental internal invariants. Validation
that affects the helper's behavior should use an explicit conditional and a
deliberate exception, stderr message, or nonzero return status. This preserves
the check under optimization and gives the caller a stable failure contract.

This rule was also observed directly during the incidental-helper evaluation:
the generated independent verifier used `assert` for all report checks. It
worked normally but would not provide those checks under optimized execution.

References:

- [Python `assert` statement](https://docs.python.org/3/reference/simple_stmts.html#the-assert-statement)
- [Python `-O` option](https://docs.python.org/3/using/cmdline.html#cmdoption-O)

## Bound potentially unbounded waits

Some operations have no natural completion guarantee: a child process may
never exit, a network peer may never answer, an async event may never be set,
or a polling condition may never become true. Without a timeout, deadline,
attempt limit, or work bound, a small helper can remain alive indefinitely
without producing output.

This is a preventive engineering rule, not a claim that every AI-generated
helper hangs frequently. Published evidence does not currently quantify hang
rates specifically for one-off AI-written Python scripts. Python's APIs do,
however, document the underlying failure modes:

- `subprocess.run(..., timeout=...)` terminates and waits for an overdue child.
- `Popen.wait()` can deadlock when a child fills a configured stdout or stderr
  pipe; `communicate()` drains the pipes safely. If timed communication expires,
  the caller must terminate or kill the child, call `communicate()` again, and
  reap the process.
- `asyncio.timeout()` and `asyncio.wait_for()` bound awaits and initiate
  cancellation when the deadline expires.

Timeouts should cover operations whose progress depends on something external
or on synchronization. They should not be added indiscriminately to finite
local parsing, normal file reads, or bounded calculations. Choose a bound from
the operation's semantics—such as a protocol deadline, expected duration with
margin, attempt limit, or work-item limit—not from one universal magic number.

For legitimately long operations, concise progress on stderr makes the script
observable: announce the operation, periodically report meaningful counts or
elapsed time, and flush the output. A heartbeat is diagnostic only; it does not
replace a deadline. On timeout, the helper should clean up resources, preserve
cancellation semantics, handle the exception raised by the selected API and
Python version, emit a concise error, and return nonzero. In particular,
`subprocess` timeouts raise `subprocess.TimeoutExpired`; async timeout exception
names differ across supported Python versions.

Interactive input deserves the same treatment. A call to `input()` or an
unqualified read from stdin can wait forever in a noninteractive agent run. A
helper that requires stdin should ensure it was intentionally piped or fail
clearly when attached to a terminal.

References:

- [Python `subprocess` timeouts and pipe handling](https://docs.python.org/3/library/subprocess.html)
- [Python `asyncio` timeouts](https://docs.python.org/3/library/asyncio-task.html#timeouts)
