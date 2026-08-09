# Python 3.14

Use Python 3.14 syntax and standard-library features only when the project minimum is 3.14 or newer.

Notable options include deferred annotation evaluation, template string literals, `concurrent.interpreters`, `concurrent.futures.InterpreterPoolExecutor`, and `compression.zstd`. Treat the free-threaded build as a deployment choice, not an assumption about the runtime.

Prefer established, readable syntax over using a new feature merely because it exists. Check the project's type checker and dependency compatibility before relying on newly introduced behavior.
