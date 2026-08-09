# Test: Zero-dependency macOS plist utility

## Prompt
"Write a macOS utility that runs with Apple's `/usr/bin/python3` and no package manager. Read a plist, extract a URL, and open it. It should work on the Python included with Command Line Tools."

## MUST Contain
- The exact shebang `#!/usr/bin/python3`
- Python 3.9-compatible syntax and complete function annotations
- `plistlib` for reading the plist
- `subprocess.run(["/usr/bin/open", url], check=True)` or an equivalent argument list
- Verification with `/usr/bin/python3 -E -s -S`

## MUST NOT Contain
- `#!/usr/bin/env /usr/bin/python3`
- Third-party imports or package installation
- `shell=True`
- Python 3.10-or-newer annotation syntax
