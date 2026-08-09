---
name: python-simple-scripts
description: Use before any Bash command that invokes Python, including Bash(python3 ...), Bash(python ...), python3 -c, python -c, Python heredocs, and temporary .py helper files. Also use whenever an agent creates a one-off Python script to inspect, transform, validate, or summarize data during a coding session, even when the user did not ask for Python or for a script.
---

# Simple Python Scripts

Write the smallest trustworthy helper for the immediate task.

Loading this skill does not mean every Python invocation needs new code. If the
command only runs an existing script, module, test suite, or configured project
tool, preserve that command and do not manufacture a helper. Apply the rules
below when composing Python for the task.

## Distinguish a helper from a deliverable

For an incidental helper used by the agent during a coding session:

- Use the Python interpreter already available in the execution environment.
  Do not ask the user to choose a supported Python version.
- Do not create `pyproject.toml`, a package layout, a lockfile, a virtual
  environment, or project configuration.
- Use the standard library. Do not install or download runtime dependencies,
  formatters, linters, or type checkers for the helper.
- Keep caches out of the working tree. Prefer `python3 -B helper.py` when bytecode
  is unnecessary.
- Keep the helper temporary unless the user asks to retain it. If it is retained
  for audit, report its path.

For a script requested as a repository deliverable, stop treating it as an
incidental helper. Use applicable skills from `python-development` when
available; otherwise use applicable skills from `python-scripting`. Follow the
repository's declared Python version and toolchain. If no supported version is
declared, ask and offer Python 3.14 as the default.

For Apple's `/usr/bin/python3` or a zero-setup macOS utility, also use
`macos-python-scripting` and follow its Python 3.9 constraints.

## Choose a proportionate form

- Use `python3 -c` only for a short expression whose shell quoting is obvious.
- Use a small temporary `.py` file for multiline logic, structured data,
  nontrivial error handling, or anything worth rerunning.
- Prefer one helper over a chain of opaque shell pipelines.
- Do not add a second verifier, framework, abstraction layer, or generalized
  CLI unless the task's risk or reuse justifies it.

For a multiline helper, normally use focused functions, complete function
signatures, a `main()` entry point, and an explicit exit status. Let inference
handle obvious local values rather than annotating every literal.

## Cross the shell boundary safely

- Prefer a temporary `.py` file once code is multiline or contains nested
  quoting. Do not compress substantial logic into `python3 -c`.
- If a heredoc is genuinely the clearest form, quote its delimiter as
  `<<'PY'` so Bash does not expand `$`, backticks, or backslashes inside the
  Python source.
- Never splice paths, JSON, user text, or command output into Python source.
  Pass dynamic values through positional arguments, stdin, or environment
  variables, then parse them in Python.
- Do not use command substitution when trailing newlines are meaningful, and
  do not rely on an unquoted shell expansion to preserve one argument.
- When Python launches another program, use an argument list with
  `subprocess.run(..., check=True)`; avoid `shell=True` and add a timeout when a
  child can hang.

## Bound waits and expose progress

Do not add arbitrary timeouts to bounded local computation or ordinary file
processing. When completion depends on external progress, synchronization, or
input that may never arrive, the wait is potentially unbounded and MUST have a
finite timeout, deadline, attempt limit, or work-item bound.

- Choose each bound from task semantics, such as a protocol deadline, expected
  operation duration with margin, maximum attempts, or maximum work items. Do
  not use one universal magic timeout.
- Give potentially unbounded `subprocess.run()` calls a meaningful `timeout=`
  and handle `subprocess.TimeoutExpired`. When using `Popen` with pipes, use
  `communicate(timeout=...)` rather than `wait()`. On timeout, terminate the
  child, then kill it if necessary, and call `communicate()` again to drain its
  pipes and reap it.
- Give synchronous network and socket operations an explicit timeout.
- Bound async subprocesses, network calls, tasks, queues, events, and locks
  with `asyncio.timeout()` on Python 3.11+ or `asyncio.wait_for()` when the
  supported interpreter requires it. After an async subprocess times out,
  terminate or kill it and await its cleanup.
- Handle the timeout exception actually raised by the selected API and Python
  version at the CLI boundary, clean up resources in `finally`, and return
  nonzero. Let `asyncio.CancelledError` propagate after cleanup; never swallow
  it with a broad handler.
- Bound polling and retries with both a deadline or attempt limit and a delay.
  Report meaningful state changes or rate-limited progress to stderr rather
  than printing every fast polling attempt.
- Do not call `input()` or wait on an interactive stdin in a noninteractive
  agent run. If stdin is required, ensure it is intentionally piped or fail
  clearly when it is a terminal.
- Before a legitimately long operation, state what is starting. Emit occasional
  progress with completed counts or elapsed time to stderr using `flush=True`.
  Progress output is not a substitute for a timeout or other bound.
- Bound CPU loops by input size, iteration count, or an explicit deadline when
  termination is not otherwise evident.

## Make the result trustworthy

- Treat decoded JSON, plist, CSV rows, command output, and similar inputs as
  untrusted. Validate the shape and values that affect the answer instead of
  assuming nested keys and types.
- Remember that `bool` is an `int` subclass when validating true integers.
- For CLI flags, use `action="store_true"`, `action="store_false"`, or
  `BooleanOptionalAction`; do not use `type=bool`, because nonempty text such as
  `"False"` converts to true.
- Keep input files read-only unless transformation is the requested outcome.
- Avoid `Any`, `cast()`, and ignores when straightforward narrowing suffices.
- Emit concise errors to stderr and return nonzero for malformed input rather
  than silently skipping unknown data.
- Avoid shell interpolation of data-derived values; pass arguments as arrays
  when invoking other programs.
- Resolve whether relative paths are relative to the invocation directory or
  the helper file, and encode that choice explicitly. Do not accidentally mix
  the two.
- Specify text encodings. Open CSV files with `newline=""`, and reject an empty
  input glob when the task expects files.
- Use `tempfile` for temporary data created by Python; never invent a shared
  predictable `/tmp` filename or use `tempfile.mktemp()`.

Use `python-typing` when the helper has nontrivial validated data shapes. Use
`python-quality-tools` only when the user requests formatting, linting, or type
checking for a standalone file with no governing repository toolchain. For a
retained repository deliverable with configured quality tools, use
`python-development:python-project-tooling` when it is available.

## Verify without building a project

Run the helper on the real input and inspect the result. Add one focused edge
or malformed-input probe when a silent wrong answer is plausible. Do not create
a separate test suite or bootstrap quality tools for an incidental helper.

Do not use `assert` as the sole runtime validation or verification mechanism;
optimized Python can disable assertions. Confirm subprocess exit codes and the
helper's own nonzero failure path. When the helper contains a potentially
unbounded operation, exercise its timeout or limit with a short deterministic
probe.

Before finishing, confirm that the helper did not modify its inputs, create
project metadata, install dependencies, or leave caches in the working tree.
