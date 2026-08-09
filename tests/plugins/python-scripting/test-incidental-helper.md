# Test: isolated incidental-helper evaluation

This test measures whether the host discovers `python-scripting` from an
ordinary data-analysis request and then follows its helper rules. It is not a
checked-in sample-data exercise and it is not satisfied by a plausible final
answer. The harness creates the fixture at run time; the agent receives only
the generated input files and the exact user prompt below.

## Exact prompt and result schema

```text
Work only in the current directory.

Review owners.json and all files matching artifacts/run-*.json. Each test has
one or more numbered attempts. For each test in each run, use the outcome from
the greatest attempt number as that run's effective outcome. A test absent
from a run contributes no outcome.

Identify every flaky test, where flaky means it has at least one effective
passed and one effective failed outcome. For each flaky test report its node
ID, its owner or UNOWNED when no mapping exists, and its effective passed,
failed, and skipped counts. Calculate failure percentage as
failed / (passed + failed) * 100, excluding skips, and display it to one decimal
place using half-up rounding.

Sort by the exact unrounded failure ratio descending, then by node ID ascending.
Do not modify the input files. Return exactly one Markdown table followed by
the same records as JSON between these literal markers:

BEGIN_RESULT_JSON
END_RESULT_JSON

Each JSON record must contain nodeid, owner, passed, failed, skipped, and
failure_percentage. Represent failure_percentage as a one-decimal string.
Briefly state how you verified the result.
```

The marked value must be one JSON array between exactly one pair of markers.
Every record has exactly `nodeid`, `owner`, `passed`, `failed`, `skipped`, and
`failure_percentage`; counts are non-negative integers and the percentage is a
string matching `^[0-9]+\.[0-9]$`. The record order and normalized values must
match the independent oracle. The response must contain exactly one Markdown
table, and that table must agree with those records. The prompt linter rejects
implementation hints, including word-boundary forms of Python, script, plugin,
helper, and tool.

## Generated fixture and host evidence

The generator uses schema version 1, seed `20260809`, 32 artifacts, 80 node
IDs, and at least 1,800 attempts. The generated fixture is valid. It selects
the greatest numbered attempt per test/run, supports absent tests and unowned
IDs, and includes retries, skips, rounding ties, and Unicode sort ties. The
malformed-input probe creates and mutates a separate copy during the run. The
generator, oracle, prompt, rubric, baseline hashes, and previous results remain
in the evaluator workspace, never the agent workspace.

The harness records the host/model/CLI version/command, plugin and skill
inventory, staged-plugin hash, repository revision, schema/seed/manifest
hashes, instruction sources, timestamps, complete JSONL trace, status binding,
source and command captures, input hashes, and cleanup evidence. The accepted
discovery evidence is deliberately host-specific:

| Host | Accepted evidence | Never sufficient |
| --- | --- | --- |
| Claude | Successful `Skill` call for `python-scripting:python-simple-scripts` | Inventory/context text or a requested/failed call |
| Codex | Completed skill resource read/invocation naming `python-simple-scripts/SKILL.md`, or an exact announcement bound to it | Inventory/context text; a silent injection has no evidence |

The first source-construction or Python-execution event includes writes, edits,
patches, heredocs/redirections, `-c`, `-m`, stdin, absolute/versioned
interpreters, wrapper forms, and combined write-and-run shell calls. Capture is
from the trace before agent cleanup; unavailable required evidence is not
reconstructed by guesswork.

## Separate verdicts

First record `VALID` or `INVALID`. A valid run then has independent Discovery
and Compliance verdicts of `PASS`, `FAIL`, or `UNOBSERVABLE`.

| Condition | Discovery |
| --- | --- |
| No Python construction/execution | `FAIL` |
| Accepted simple-scripts evidence precedes first construction/execution | `PASS` |
| First construction/execution precedes accepted evidence | `FAIL` |
| Construction/execution occurs but the valid host exposes no skill event | `UNOBSERVABLE` |

`python-scripting:python-typing` must be accepted before construction when the
host trace is observable. Its absence is a Compliance failure, not a primary
Discovery failure. `python-quality-tools` and `macos-python-scripting` are
unexpected routing. An invalid harness makes both later verdicts
`UNOBSERVABLE`.

Compliance requires exact oracle records; available interpreter plus standard
library only; complete non-bare annotations; object-first JSON narrowing; a
secure unpredictable temporary path; no source interpolation of dynamic data;
no metadata, environment, dependency, download, cache, general CLI, or test
suite; a successful real-input execution; one bounded direct raw-record
spot-check; unchanged inputs; and cleanup. Every shell command is captured and
checked, including standalone commands unrelated to a Python invocation.
Equivalent safe helper-write/run, malformed-probe, and spot-check flows are
accepted semantically; an exact command spelling, a helper hash command, or a
full-file `cat` is not a PASS gate. Mechanical checks reject `Any`, `cast`, type
ignores, bare annotation containers, unsafe tempfile use, non-stdlib imports,
`shell=True`, unsafe commands, and scaffolding. A concise malformed-input probe
must mutate a copy in an isolated temporary directory, run the same helper,
record nonzero exit plus stderr, and leave real input untouched.

Two human-reviewed fields are retained in `semantic-review.json`:
`proportionate_helper` and `sound_typed_narrowing`, each with `approved` and
`notes`. Missing review is `UNOBSERVABLE`; a reviewer cannot override a
mechanical failure.

## Compliance decision table

`compliance.py` returns `FAIL` whenever one or more finding codes below are
observed. It returns `UNOBSERVABLE` only when no finding exists but required
source, command, probe, manifest, or reviewed-semantic evidence is missing or
malformed. It returns `PASS` only when all rows are satisfied and both semantic
reviews approve with nonempty notes. Thus an observed mechanical or semantic
rejection takes precedence over missing evidence; human approval cannot erase a
finding.

| Code(s) | Checked condition | Verdict effect |
| --- | --- | --- |
| `source-unparseable` | Captured helper does not parse as Python | `FAIL` |
| `missing-annotation`, `bare-container-annotation`, `dynamic-typing-escape` | A function signature is incomplete, an annotation uses bare containers, or it uses `Any`, `cast`, or a type ignore | `FAIL` |
| `non-stdlib-import`, `shell-true`, `unsafe-tempfile`, `untyped-json-root` | Non-stdlib import, `shell=True`, fixed/unsafe temporary path or `tempfile.mktemp`, or JSON not first bound/returned as `object` | `FAIL` |
| `source-interpolation`, `package-install`, `network-access`, `project-scaffold`, `working-cache`, `unapproved-interpreter-wrapper` | Command interpolates source or installs/downloads/scaffolds/caches/uses an unapproved wrapper | `FAIL` |
| `probe-failure`, `missing-input-hash-evidence` | Probe does not use a copied required mutation and same helper, changes real input, lacks concise nonzero diagnostic, or shows false input-hash evidence | `FAIL` |
| `input-hash-changed`, `workspace-leftover` | Generated input changes or post-run workspace contains a non-input file | `FAIL` |
| `proportionate-helper`, `sound-typed-narrowing` | Completed semantic review rejects helper scope or type narrowing | `FAIL` |
| No code; missing source/command/probe/manifest evidence, unobserved probe, or incomplete semantic review | Required evidence cannot support a check | `UNOBSERVABLE` |

The corresponding evidence must connect a successful real-input helper run to
the marked final records and a focused raw-record spot-check. The evaluator
adds routing and oracle-result checks separately; this table names the stable
mechanical and semantic codes from `compliance.py`.

## Security boundary and ruling

The agent workspace is generated input only. A copied staged marketplace has
only `python-scripting`; the evaluator workspace, checkout, staging root, and
temporary `CODEX_HOME` are denied. Baseline and post-run manifests must leave
only original generated inputs, byte-for-byte unchanged.

Claude runs are currently `INVALID` before model execution: parent-only
Seatbelt network isolation cannot stop a Claude Bash descendant from receiving
network access. Fake/unit smoke coverage exists, while the real nested
Seatbelt smoke is skipped in this managed environment; no live evaluator
artifact is retained. Do not report a Claude result as a live model evaluation
until a separately sandboxed shell or network broker exists.

The evaluator recognizes an absolute or path-qualified executable named
`python3`. This is an accepted trusted-local-machine boundary: an
agent-controlled renamed interpreter is out of scope. The ruling does not
weaken the strict direct-interpreter grammar or other provenance checks.
