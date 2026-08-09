# Test: Keep an incidental Python helper proportionate

## Prompt

"During a coding session, I need to inspect several JSON result files to answer
one question. Describe how you would implement and verify the temporary helper.
The helper is not a repository deliverable."

## MUST Contain

- Use the Python interpreter already available in the environment without
  asking for a project support-version decision
- A small standard-library helper, with a temporary `.py` file preferred over
  complex shell quoting for multiline logic
- Validation of the JSON shapes and values that affect the result
- A concise nonzero failure for malformed or unknown input
- Direct execution on the real input and one focused failure probe
- Avoidance of working-tree caches and input mutation

## MUST NOT Contain

- `pyproject.toml`, a package layout, a lockfile, or a virtual environment
- Downloaded dependencies, formatters, linters, or type checkers
- A separate verifier, generalized framework, or test suite without risk that
  justifies it
- Asking which Python versions the project supports
