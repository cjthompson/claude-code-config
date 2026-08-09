# python-scripting GREEN Responses

Generated with `gpt-5.6-luna` after reading the corresponding skill.

## Validate untyped JSON

```python
import json
import sys
from typing import TypedDict


class Record(TypedDict):
    name: str
    count: int | None


def validate_record(value: object) -> Record:
    if not isinstance(value, dict):
        raise ValueError("record must be a JSON object")
    name = value.get("name")
    if not isinstance(name, str):
        raise ValueError("name must be a string")
    count = value.get("count")
    if count is not None and (isinstance(count, bool) or not isinstance(count, int)):
        raise ValueError("count must be an integer or null")
    return {"name": name, "count": count}


def process_line(line: str) -> Record:
    decoded: object = json.loads(line)
    return validate_record(decoded)


def main() -> None:
    for line_number, line in enumerate(sys.stdin, start=1):
        try:
            record = process_line(line)
        except (json.JSONDecodeError, ValueError) as error:
            print(f"line {line_number}: {error}", file=sys.stderr)
            continue
        print(json.dumps(record, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

The decoded value is handled as `object`, narrowed with `isinstance`, and only then used to construct the `TypedDict`. No runtime dependency, `Any`, `cast()`, or type ignore is needed.

## Respect an existing toolchain

First inspect `pyproject.toml`, lockfiles, task runners, and CI for the exact commands. With Black and mypy already configured, run their configured equivalents, for example:

```bash
black scripts/report.py
mypy scripts/report.py
```

Run a separately configured lint command if one exists; otherwise report that no linter is configured. Review formatter changes and rerun the checks. This file-scoped pass adds no Ruff, ty, uv, configuration, or tool migration.

## Zero-dependency macOS utility

```python
#!/usr/bin/python3
import argparse
import plistlib
import subprocess
import sys
from pathlib import Path
from typing import Optional


def read_url(path: Path) -> str:
    with path.open("rb") as stream:
        value: object = plistlib.load(stream)
    if not isinstance(value, dict):
        raise ValueError("plist root must be a dictionary")
    url: object = value.get("URL")
    if not isinstance(url, str) or not url:
        raise ValueError("plist must contain a non-empty string URL")
    return url


def parse_args(arguments: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("plist", type=Path)
    return parser.parse_args(arguments)


def main(arguments: Optional[list[str]] = None) -> int:
    try:
        args = parse_args(arguments)
        subprocess.run(["/usr/bin/open", read_url(args.plist)], check=True)
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Verify with `/usr/bin/python3 -E -s -S path/to/utility.py --help` and `/usr/bin/python3 -E -s -S path/to/utility.py path/to/file.plist`. The code uses only Python 3.9 standard-library features, an argument array, and no shell. If `/usr/bin/python3` is unavailable, report that Command Line Tools are required without installing or modifying the interpreter.
