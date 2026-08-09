---
name: macos-python-scripting
description: Use when writing zero-setup macOS utilities for Apple's /usr/bin/python3, Command Line Tools Python 3.9, standard-library-only execution, or integration with stable macOS command-line programs.
---

# macOS Python Scripting

Produce utilities that run without Homebrew, uv, pip, or a virtual environment.

- Start executable files with exactly `#!/usr/bin/python3`.
- Target Python 3.9 syntax: use `Optional[T]` and `Union[A, B]` rather than
  `T | None`; do not use `match`, `tomllib`, `typing.Self`, or newer APIs.
- Import only the Python 3.9 standard library. Do not rely on Apple-bundled or
  user `site-packages`, including `pip`, `setuptools`, `six`, or `future`.
- Use standard modules such as `argparse`, `json`, `plistlib`, `pathlib`, and
  `subprocess`. Type all functions and ambiguous containers. Treat decoded
  plist and JSON values as `object`, narrow them with `isinstance`, and avoid
  `Any` as a shortcut.
- Invoke stable macOS programs with absolute paths and argument arrays, for
  example `subprocess.run(["/usr/bin/open", url], check=True)`. Never use
  `shell=True` for data-derived arguments.
- Handle `OSError`, parse errors, and `subprocess.CalledProcessError` at the
  CLI boundary and return a nonzero exit status with a concise stderr message.
- Verify syntax, imports, and behavior without environment leakage:

  ```bash
  /usr/bin/python3 -E -s -S path/to/script.py --help
  /usr/bin/python3 -E -s -S path/to/script.py <test arguments>
  ```

If `/usr/bin/python3` is unavailable, report that Apple Command Line Tools are
required. Do not install or modify the interpreter.
