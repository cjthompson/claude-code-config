# Python Scripting Incidental Helper Test Design

## Goal

Upgrade the `python-scripting` incidental-helper test so manual processing is
not a reasonable strategy. Measure independently whether an agent discovers
`python-simple-scripts` without a Python or tool hint and whether the helper it
creates follows the skill's rules.

## Isolated Harness

The harness creates three fresh, securely named directories outside the
repository:

1. an agent workspace containing only generated input files;
2. a staged copy containing only the `python-scripting` plugin; and
3. an evaluator workspace containing the generator manifest, baseline hashes,
   oracle, rubric, traces, and captured artifacts.

Run the CLI with operating-system or container isolation that exposes only the
agent workspace, staged plugin, required CLI/runtime files, and credentials.
The repository, generator, oracle, evaluator workspace, and prior results must
not be readable by the agent. If a host cannot enforce that boundary, mark the
run `INVALID` rather than treating prompt instructions as isolation.

Enable only the staged `python-scripting` plugin plus unavoidable host
built-ins. Record the following with every run:

- host, model, CLI version, and complete command line;
- staged plugin content hash and repository revision;
- enabled plugins and skills;
- inherited system, user, repository, and session-start instruction sources;
- fixture schema version, generator seed, and manifest hash; and
- start and end timestamps.

This prevents another skill package, especially a general skill-enforcement
plugin, from becoming an unrecorded discovery confounder.

### Clean Codex configuration

For Codex CLI 0.138.0 or later, create an existing empty directory as
`CODEX_HOME`. Stage a marketplace containing only `python-scripting`, then run
`codex plugin marketplace add <staged-marketplace>` and
`codex plugin add python-scripting@<marketplace>` with that `CODEX_HOME`.

Write a temporary `config.toml` that selects a custom permission profile. The
profile grants `:minimal` read access and write access only to the agent
workspace. It explicitly denies the repository, evaluator workspace, staged
marketplace, and `CODEX_HOME`. Do not pass `--sandbox`, because legacy sandbox
settings override permission profiles. Run noninteractively with no approval
escalation and strict config validation.

Render this template with absolute paths and a minimal resolved executable
path:

```toml
default_permissions = "python-scripting-test"

[permissions.python-scripting-test.filesystem]
":minimal" = "read"
"<repository>" = "deny"
"<evaluator-workspace>" = "deny"
"<staged-marketplace>" = "deny"
"<CODEX_HOME>" = "deny"

[permissions.python-scripting-test.filesystem.":workspace_roots"]
"." = "write"

[permissions.python-scripting-test.network]
enabled = false

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[shell_environment_policy.set]
PATH = "<minimal-resolved-PATH>"
HOME = "<agent-workspace>"
LANG = "C.UTF-8"
PYTHONNOUSERSITE = "1"

[shell_environment_policy.filters]
"PATH" = "include"
"HOME" = "include"
"LANG" = "include"
"PYTHONNOUSERSITE" = "include"
```

Invoke the test as `env CODEX_HOME=<CODEX_HOME> codex --strict-config
--ask-for-approval never -C <agent-workspace> --model <model> exec --ephemeral
--skip-git-repo-check --json -` with the prompt on stdin. Global flags
deliberately precede the `exec` subcommand. Do not pass `--sandbox` or
`--add-dir`.

Automated Codex runs authenticate before the test with exactly one of:

```sh
printenv OPENAI_API_KEY | env CODEX_HOME=<CODEX_HOME> codex login --with-api-key
printenv CODEX_ACCESS_TOKEN | env CODEX_HOME=<CODEX_HOME> codex login --with-access-token
```

They never copy a user's `~/.codex/auth.json`. Disable shell tracing while
authenticating and unset both credential variables before starting the agent.
The resulting temporary authentication file is inside the denied `CODEX_HOME`
and is deleted with that directory after the run. Configure
`shell_environment_policy` with
`inherit = "none"`, `ignore_default_excludes = false`, and an explicit
allowlist containing only non-secret runtime variables required by the
interpreter. The credential must not appear in the agent workspace, tool
environment, command trace, or result artifacts. If authentication or the
permission profile cannot meet these conditions, the Codex run is `INVALID`.

Before the agent run, execute `codex --strict-config doctor --json` with the
temporary `CODEX_HOME` and require successful config parsing, recognized
restricted filesystem/network policy, and valid authentication. An automated
CLI smoke test must also confirm that the documented global flags followed by
`exec --help` exit zero; this guards against moving a top-level flag behind the
subcommand again.

## Fixture Schema

Use schema version `1`, seed `20260809`, exactly 32 run artifacts, 80 distinct
test IDs, and at least 1,800 attempt records. Serialize JSON as UTF-8 with
sorted object keys and a trailing newline.

`owners.json` is an object whose keys are node IDs and whose values are owner
strings. Some valid node IDs deliberately have no mapping.

Each `artifacts/run-NNN.json` has this shape:

```json
{
  "run_id": "run-NNN",
  "schema_version": 1,
  "tests": [
    {
      "attempts": [
        {"attempt": 1, "outcome": "failed"},
        {"attempt": 2, "outcome": "passed"}
      ],
      "nodeid": "tests/example.py::test_case"
    }
  ]
}
```

The valid fixture obeys these invariants:

- run IDs are unique and match their filenames;
- a node ID occurs at most once per run;
- attempt numbers are unique positive integers and are not booleans;
- attempt arrays may be out of order;
- outcomes are exactly `passed`, `failed`, or `skipped`;
- the greatest attempt number determines the effective outcome for that run;
- absence from a run contributes no count;
- awkward but valid node IDs and owner strings exercise escaping; and
- fixture properties guarantee percentage and node-ID sorting ties, missing
  owners, retries that change outcomes, skips, and absent executions.

For each test, count effective outcomes across runs. A test is flaky only when
it has at least one effective `passed` and one effective `failed`. Compute
`failed / (passed + failed) * 100`, format it to one decimal using decimal
half-up rounding, and exclude skips from the denominator. Sort by the exact,
unrounded failure ratio descending, then by Unicode node ID ascending. Report
`UNOWNED` for a missing owner.

The generator writes a manifest into the evaluator workspace containing exact
counts, input paths relative to the agent workspace, and SHA-256 hashes. The
manifest and oracle output never enter the agent workspace.

## Generator and Oracle Independence

The deterministic generator constructs fixture cases; it does not calculate
the expected report. A separate oracle parses the generated files and produces
canonical expected records without importing aggregation code from the
generator or evaluator.

Automated tests cover:

- byte-for-byte generator determinism and manifest hashes;
- all required fixture counts and edge-case invariants;
- a hand-authored small fixture with unordered retries, skips, missing runs,
  missing owners, percentage ties, and node-ID ties;
- rejection of duplicate attempt numbers, boolean attempt numbers, unknown
  outcomes, invalid schema versions, and malformed container shapes; and
- agreement between the oracle and hand-calculated expected records.

Sharing JSON decoding helpers is allowed only for canonical serialization, not
for validation, retry selection, aggregation, rounding, or sorting.

## Agent Prompt and Result Protocol

Use this exact prompt; it contains no Python, script, plugin, helper, preferred
tool, or harness hint:

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
Do not modify the input files. Return a Markdown table followed by the same
records as JSON between these literal markers:

BEGIN_RESULT_JSON
END_RESULT_JSON

Each JSON record must contain nodeid, owner, passed, failed, skipped, and
failure_percentage. Represent failure_percentage as a one-decimal string.
Briefly state how you verified the result.
```

The machine-readable array goes between the literal markers. Each record
contains `nodeid`, `owner`, `passed`, `failed`, `skipped`, and
`failure_percentage`. `failure_percentage` is a canonical one-decimal string
matching `^[0-9]+\.[0-9]$`; object key order is irrelevant. The evaluator
rejects duplicate markers or extra records and compares normalized values and
array order with the oracle. The Markdown table is user-facing and is checked
only for consistency with the marked records.

## Trace Capture and Host Adapters

Capture complete JSONL output. Assign every event its stream position and
preserve tool-call IDs so ordering is mechanical.

For Claude, accepted discovery evidence is a successful `Skill` tool call with
`skill` equal to `python-scripting:python-simple-scripts`. For Codex, accepted
evidence is an explicit skill-read or invocation event naming the staged
`python-simple-scripts/SKILL.md`, or an exact skill-use announcement tied to a
resource/tool event. Skill inventory or description text in initial context is
never evidence. If a valid Codex run injects the skill silently and exposes no
such event, discovery may be `UNOBSERVABLE` only under the decision table
below.

The trace adapter identifies the first tool call that can construct or execute
Python, including:

- `Write`, `Edit`, or patch payloads that create Python source;
- shell heredocs or redirections that create Python source;
- `python`, `python3`, versioned or absolute interpreter paths;
- `env` or runner wrappers that resolve to a Python interpreter;
- `-c`, `-m`, stdin, and `.py` execution forms; and
- a single shell tool call that both writes and executes the helper.

Discovery is `PASS` only when accepted skill evidence precedes that entire tool
call. It is `FAIL` when the first construction/execution call precedes accepted
evidence or no evidence appears on a host that exposes skill events.

The collector snapshots source and command payloads from trace events before
cleanup. It records reconstructed helper source, Python invocations, malformed
probe commands and results, stderr, exit codes, and cleanup commands in the
evaluator workspace. If required evidence cannot be reconstructed, mark the
affected verdict `UNOBSERVABLE` instead of guessing.

Maintain baseline and post-run manifests for the complete agent workspace.
Only the generated input files may exist at the end. Their hashes must be
unchanged, and no helper, metadata, environment, dependency, cache, report, or
other artifact may remain.

## Independent Verdicts

First record harness validity as `VALID` or `INVALID`. A valid run receives two
separate verdicts, each `PASS`, `FAIL`, or `UNOBSERVABLE`.

### Discovery and ordering

Apply the host adapter above. The primary requirement is observable use of
`python-scripting:python-simple-scripts` before the first Python construction
or execution event. A correct no-helper solution still fails discovery.

Apply states in this order:

1. If no Python helper construction or execution occurs, discovery is `FAIL`.
2. If accepted skill evidence occurs before the first construction/execution
   tool call, discovery is `PASS`.
3. If the first construction/execution call occurs before accepted evidence,
   discovery is `FAIL`.
4. If construction/execution occurs but the valid host trace cannot expose
   skill-use evidence, discovery is `UNOBSERVABLE`.

Because this fixture contains nontrivial validated JSON shapes,
`python-scripting:python-typing` is expected before helper construction when
the host exposes skill events. Record its routing separately; its absence is a
compliance failure on an observable host, not a failure of primary discovery.
`python-quality-tools` and `macos-python-scripting` are unexpected.

### Skill compliance

Compliance passes only when all objective requirements and both reviewed
semantic requirements pass:

- marked output records exactly match the oracle;
- execution uses the available interpreter and standard library only;
- every function parameter and return is annotated; annotation ASTs contain no
  unsubscripted `list`, `dict`, `set`, or `tuple`, `Any`, `cast()`, or type
  ignores;
- decoded JSON is first assigned or returned as `object` before narrowing;
- any temporary helper or data path is created through a secure unpredictable
  mechanism such as `mktemp`, `mktemp -d`, or `tempfile`, not a fixed shared
  `/tmp` name;
- dynamic paths and values cross through arguments, stdin, or environment
  variables and are never interpolated into Python source;
- no project metadata, environment, downloaded tool, dependency, separate
  test suite, generalized CLI, or working-directory cache is created;
- the trace contains a successful real-input helper execution whose captured
  output supplies the marked final records;
- one focused spot-check directly inspects selected raw records without
  creating a second verifier; and
- all temporary artifacts are removed and original input hashes are unchanged.

The malformed-input probe must copy one input into the helper's isolated
temporary directory, change either an attempt number to a boolean or an outcome
to an unknown string, run the same helper against that copy, and capture a
concise stderr diagnostic plus a nonzero exit. The probe must not alter the
real fixture.

If source, commands, or exit results needed for a compliance rule are hidden by
the host, compliance is `UNOBSERVABLE`. Human review is limited to whether the
helper and spot-check are proportionate and whether JSON narrowing produces
accurate internal types without unchecked dynamic access. It cannot override
failed mechanical requirements.

Mechanical source checks parse the captured helper with `ast`: reject
prohibited annotation constructs, `shell=True`, `tempfile.mktemp()`, source
interpolation of dynamic paths, and imports whose top-level module is not in
the tested interpreter's `sys.stdlib_module_names`. Trace checks reject package
installation, network access, project scaffolding, and unapproved interpreter
wrappers. The harness sets `PYTHONNOUSERSITE=1`. These checks supplement, not
replace, execution of the malformed probe and oracle comparison. Restricting
bare containers applies only to annotations and enforces the skill's complete
signature requirement; ordinary inferred local containers remain allowed.

## Test Execution

Reproducible Claude and Codex instructions must:

1. create clean isolated directories and stage the plugin;
2. generate the fixture and evaluator manifest;
3. start the agent with only the prompt and staged plugin;
4. capture complete JSONL output and run metadata;
5. apply the host-specific discovery adapter;
6. snapshot helper and command evidence from the trace;
7. compare marked result records with the independent oracle;
8. evaluate the malformed probe, workspace manifests, and compliance rules;
   and
9. write the validity plus discovery/compliance outcome matrix.

Retain fixture traces for adapter regression tests. Include synthetic trace
fixtures covering Claude and Codex skill evidence, inventory-only mentions,
`Write`, patch, heredoc, `python -c`, absolute interpreters, wrapper commands,
and a combined write-and-run shell event.

Lint the exact prompt in an automated test. Assert all retry, counting,
rounding, sorting, missing-owner, output-marker, and read-only requirements are
present, and reject case-insensitive word-boundary occurrences of `python`,
`script`, `plugin`, `helper`, and `tool`.

## Acceptance Criteria

- Another machine can reproduce the fixture and oracle from repository
  contents and obtain identical manifest hashes.
- The isolated agent cannot read the repository, generator, oracle, evaluator,
  baseline hashes, rubric, or prior results.
- The staged plugin hash, host/model/CLI versions, enabled capabilities, and
  instruction sources are recorded.
- The prompt contains none of the forbidden implementation hints.
- The fixture contains exactly 32 runs, 80 test IDs, and at least 1,800 attempt
  records.
- Claude and Codex trace adapters pass regression fixtures for every supported
  construction and invocation form.
- Deleted helper source, commands, malformed-probe evidence, input hashes, and
  cleanup are auditable outside the agent workspace.
- The outcome report contains harness validity plus discovery and compliance
  verdicts, with explicit reasons for every `FAIL`, `UNOBSERVABLE`, or
  `INVALID` result.
- A correct final report cannot pass omitted skill invocation or material skill
  violations; a correct no-helper solution fails discovery.
