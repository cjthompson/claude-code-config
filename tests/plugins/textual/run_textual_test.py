#!/usr/bin/env python3
"""
Textual app test runner.

Usage:
    python run_textual_test.py <app_file.py>

Finds the first App subclass in the given file, runs it with Textual's
headless run_test() harness, and reports PASS or lists every CSS error.

Exit codes:
    0  PASS — app ran without CSS errors
    1  FAIL — CSS parsing errors (printed to stdout)
    2  ERROR — file not found, no App subclass, or unexpected exception
"""

import asyncio
import importlib.util
import inspect
import sys
import traceback
from pathlib import Path


def load_app_class(filepath: str):
    """Dynamically load the first App subclass from a Python file."""
    try:
        from textual.app import App
    except ImportError:
        print("ERROR: textual is not installed in this Python environment.")
        print("Run: pip install textual")
        sys.exit(2)

    path = Path(filepath).resolve()
    if not path.exists():
        print(f"ERROR: File not found: {filepath}")
        sys.exit(2)

    spec = importlib.util.spec_from_file_location("_textual_test_app", path)
    module = importlib.util.module_from_spec(spec)

    try:
        spec.loader.exec_module(module)
    except Exception as e:
        print(f"ERROR: Could not import {filepath}")
        print(f"  {type(e).__name__}: {e}")
        sys.exit(2)

    # Find the first class that subclasses App (excluding App itself)
    app_classes = [
        obj for _, obj in inspect.getmembers(module, inspect.isclass)
        if issubclass(obj, App) and obj is not App and obj.__module__ == "_textual_test_app"
    ]

    if not app_classes:
        print(f"ERROR: No App subclass found in {filepath}")
        sys.exit(2)

    return app_classes[0]


async def run_app(app_class):
    """Run the app headlessly and return (passed, error_text)."""
    app = app_class()
    try:
        async with app.run_test(headless=True) as pilot:
            pass
        return True, None
    except Exception as e:
        return False, str(e)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <app_file.py>")
        sys.exit(2)

    filepath = sys.argv[1]
    app_class = load_app_class(filepath)

    print(f"Testing: {app_class.__name__} from {Path(filepath).name}")

    # Capture stderr to intercept Textual's CSS error rendering
    import io
    from contextlib import redirect_stderr

    stderr_capture = io.StringIO()
    passed = False
    error_text = None

    try:
        with redirect_stderr(stderr_capture):
            passed, error_text = asyncio.run(run_app(app_class))
    except SystemExit as e:
        passed = False
        error_text = f"SystemExit({e.code})"
    except Exception as e:
        passed = False
        error_text = traceback.format_exc()

    stderr_output = stderr_capture.getvalue()

    if passed:
        print("PASS — app ran without CSS errors")
        sys.exit(0)
    else:
        print("FAIL — CSS or runtime errors detected")
        print()
        if stderr_output.strip():
            print(stderr_output)
        if error_text and "StylesheetParseError" not in str(error_text):
            print(error_text)
        sys.exit(1)


if __name__ == "__main__":
    main()
