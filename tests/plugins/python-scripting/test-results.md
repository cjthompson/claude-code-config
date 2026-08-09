# python-scripting Test Results

Results dated 2026-08-08 predate the 2026-08-09 split that moved established
repository toolchains to `python-development:python-project-tooling`.

| Date | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 2026-08-08 | Validate untyped JSON | Baseline: FAIL | Used `Any` for parsed JSON and returned the raw dict. |
| 2026-08-08 | Standalone quality tools | Baseline: PASS | Correctly chose `uvx ruff` and `uvx ty`; scenario was not discriminating. |
| 2026-08-08 | Respect existing toolchain | Baseline: FAIL | Introduced Ruff despite the stated Black/mypy toolchain. |
| 2026-08-08 | Zero-dependency macOS utility | Baseline: FAIL | Used invalid env shebang and omitted type annotations/isolation verification. |
| 2026-08-08 | Validate untyped JSON | GREEN: PASS (independent) | Narrowed from `object`, modeled validated data, and explicitly rejected boolean counts. |
| 2026-08-08 | Respect existing toolchain | GREEN: PASS (independent, revision 2) | Preserved Black and mypy, reported the missing linter, and avoided migration. |
| 2026-08-08 | Zero-dependency macOS utility | GREEN: PASS (independent, revision 2) | Used the exact shebang, 3.9 syntax, stdlib plist handling, safe `open`, and isolated verification. |
| 2026-08-09 | Standalone quality tools | Revised scenario: NOT RUN | Now isolates the no-project `uvx` workflow; independent evaluation remains pending. |

## Isolated incidental-helper matrix — 2026-08-09

| Host/model | Validity | Discovery | Compliance | Evidence and disposition |
| --- | --- | --- | --- |
| Claude Sonnet 5 | `INVALID` | `UNOBSERVABLE` | `UNOBSERVABLE` | No model execution. Parent-only Seatbelt isolation cannot deny network to a Bash descendant. Unit smoke coverage uses fakes; the real nested Seatbelt smoke is skipped in this managed environment, and no live evaluator artifact exists. |
| Codex `gpt-5.6-terra` | `INVALID` (prerequisite blocked) | `UNOBSERVABLE` | `UNOBSERVABLE` | The supported CLI exists, but both supported environment credentials were absent. No credential was inspected, copied, or sent, and no model result was invented. |

The matrix is not a model ranking. `INVALID` prevents a Discovery or Compliance
conclusion. Future live runs must retain the complete bound evidence bundle:
generated agent workspace, staged marketplace, evaluator metadata, status,
host evidence, trace, evaluation JSON, immutable hashes, source/command/probe
captures, and `semantic-review.json`. A human must complete both semantic
fields with approval decisions and nonempty notes before the real retained-data
reevaluation can report Compliance `PASS`; include the exact reason for every
non-pass state.

The accepted trusted-local-machine ruling remains documented in the rubric:
path-qualified executables named `python3` are recognized, while an
agent-controlled renamed interpreter is outside this harness's threat model.
