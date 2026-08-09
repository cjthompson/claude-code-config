# Python Scripting Incidental Helper Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manually tractable incidental-helper fixture with an isolated, deterministic Claude/Codex evaluation that separately scores automatic `python-simple-scripts` discovery and compliance.

**Architecture:** A standard-library Python harness generates a large hidden fixture, computes the oracle independently, launches either host in a temporary isolated workspace, and evaluates JSONL traces. Prompt parsing, trace discovery, source compliance, and host launch mechanics stay in separate modules so they can be tested without paid model calls.

**Tech Stack:** Python 3.11+ standard library, `unittest`, Claude Code 2.1.226+, Codex CLI 0.147.0+, macOS `sandbox-exec`, Markdown.

## Global Constraints

- Implement [the approved design](../specs/2026-08-09-python-scripting-incidental-helper-test-design.md) exactly.
- Use schema version `1`, seed `20260809`, 32 run files, 80 distinct node IDs, and at least 1,800 attempt records.
- Share no retry selection, validation, aggregation, rounding, or sorting logic between generator and oracle.
- The agent prompt must contain no case-insensitive word-boundary occurrence of `python`, `script`, `plugin`, `helper`, or `tool`.
- Never expose repository, oracle, evaluator, hashes, rubric, or prior results to the agent workspace.
- Never read or write `~/.codex`; use a temporary `CODEX_HOME` and stdin login.
- Add no harness dependency, Python project metadata, or virtual environment.
- Run Python verification with `-B` to avoid `__pycache__`.
- Preserve all unrelated working-tree changes.
- Do not commit or install packages without explicit user authorization.

## File Structure

Create `tests/plugins/python-scripting/harness/`:

- `generate_fixture.py` — generation and manifest only.
- `oracle.py` — independent validation and report calculation.
- `protocol.py` — prompt lint and final-result parsing.
- `trace_eval.py` — Claude/Codex event normalization and discovery ordering.
- `compliance.py` — AST, command, probe, and cleanup checks.
- `prepare_run.py` — isolated directories and host configuration.
- `run_host.py` — secret-safe host subprocess execution.
- `evaluate_run.py` — final validity/discovery/compliance matrix.
- `test_*.py` — focused unit tests.
- `fixtures/oracle-small/` and `fixtures/traces/` — hand-authored regressions.
- `expected/fixture-manifest.json` and `expected/report.json` — deterministic snapshots.

Modify the prompt, rubric, instructions, index, results log, and structural test. Delete the obsolete checked-in eight-run fixture only after the generator/oracle tests pass.

---

### Task 1: Deterministic Generator and Independent Oracle

**Files:**

- Create: `tests/plugins/python-scripting/harness/generate_fixture.py`
- Create: `tests/plugins/python-scripting/harness/oracle.py`
- Create: `tests/plugins/python-scripting/harness/test_fixture.py`
- Create: `tests/plugins/python-scripting/harness/test_oracle.py`
- Create: `tests/plugins/python-scripting/harness/fixtures/oracle-small/owners.json`
- Create: `tests/plugins/python-scripting/harness/fixtures/oracle-small/artifacts/run-001.json`
- Create: `tests/plugins/python-scripting/harness/fixtures/oracle-small/artifacts/run-002.json`
- Create: `tests/plugins/python-scripting/harness/fixtures/oracle-small/artifacts/run-003.json`
- Create: `tests/plugins/python-scripting/harness/expected/fixture-manifest.json`
- Create: `tests/plugins/python-scripting/harness/expected/report.json`

**Interfaces:**

- `generate_fixture(agent_workspace: Path, evaluator_workspace: Path) -> FixtureManifest`
- `hash_tree(root: Path) -> dict[str, FileDigest]`
- `build_report(agent_workspace: Path) -> tuple[ReportRecord, ...]`
- `write_report(agent_workspace: Path, destination: Path) -> None`

- [ ] **Step 1: Write failing deterministic-generation tests**

```python
def test_generation_is_deterministic_and_large_enough(self) -> None:
    with TemporaryDirectory() as left, TemporaryDirectory() as right:
        one = generate_fixture(Path(left) / "agent", Path(left) / "eval")
        two = generate_fixture(Path(right) / "agent", Path(right) / "eval")
        self.assertEqual((one.schema_version, one.seed), (1, 20260809))
        self.assertEqual((one.run_count, one.test_id_count), (32, 80))
        self.assertGreaterEqual(one.attempt_count, 1800)
        self.assertEqual(one.files, two.files)
```

Also assert unordered attempts, retries that change outcomes, missing owners, absent executions, skips, ratio ties, node-ID ties, awkward strings, canonical UTF-8 JSON, and no absolute paths in the manifest.

- [ ] **Step 2: Run the generator test and verify RED**

```bash
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_fixture.py' -v
```

Expected: import failure for missing `generate_fixture.py`.

- [ ] **Step 3: Implement generation without report calculation**

Define frozen `FileDigest` and `FixtureManifest` dataclasses plus constants `SCHEMA_VERSION = 1`, `SEED = 20260809`, `RUN_COUNT = 32`, `TEST_COUNT = 80`, and `MIN_ATTEMPT_COUNT = 1800`. Use fixed modular formulas for absence, effective outcomes, retries, and reversed attempt order. Omit owners at deterministic indexes and substitute selected awkward node IDs. Assert every required invariant before canonical serialization with `sort_keys=True` and a trailing newline. Do not calculate flaky records or percentages.

- [ ] **Step 4: Run the generator test and verify GREEN**

Run Step 2. Expected: all generator tests pass.

- [ ] **Step 5: Write failing hand-calculated oracle tests**

```python
def test_small_fixture_matches_hand_calculation(self) -> None:
    self.assertEqual(
        build_report(SMALL_FIXTURE),
        (
            ReportRecord("tests/a.py::test one", "alpha", 1, 1, 1, "50.0"),
            ReportRecord("tests/b.py::test_$quote", "UNOWNED", 1, 1, 0, "50.0"),
        ),
    )

def test_rejects_boolean_attempt_number(self) -> None:
    with self.assertRaisesRegex(InputError, "positive integer"):
        build_report(self.fixture_with_attempt(True))
```

Cover duplicate attempts, unknown outcomes, invalid schema, run ID mismatch, duplicate node IDs per run, malformed owners, and non-container JSON roots.

- [ ] **Step 6: Run the oracle test and verify RED**

```bash
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_oracle.py' -v
```

Expected: import failure for missing `oracle.py`.

- [ ] **Step 7: Implement the independent oracle**

Load JSON through `object`, reject `bool` when a true integer is required, select the greatest attempt number, count effective outcomes, and sort using exact `fractions.Fraction`. Format percentages using `Decimal.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)`. Import nothing from the generator except constants used only for snapshot metadata.

- [ ] **Step 8: Generate deterministic snapshots and verify GREEN**

Run all harness tests, generate the manifest and expected report twice, assert the second generation has no diff, and inspect representative retry/tie/missing-owner records. Review checkpoint; do not commit.

---

### Task 2: Exact Prompt and Result Protocol

**Files:**

- Create: `tests/plugins/python-scripting/harness/protocol.py`
- Create: `tests/plugins/python-scripting/harness/test_protocol.py`
- Modify: `tests/plugins/python-scripting/prompts/incidental-helper.txt`

**Interfaces:**

- `lint_prompt(prompt: str) -> tuple[str, ...]`
- `extract_result_json(response: str) -> tuple[ResultRecord, ...]`
- `compare_results(actual, expected) -> tuple[str, ...]`

- [ ] **Step 1: Write the failing prompt contract**

```python
FORBIDDEN = re.compile(r"\b(?:python|scripts?|plugins?|helpers?|tools?)\b", re.I)

def test_prompt_is_indirect_and_complete(self) -> None:
    prompt = PROMPT_PATH.read_text(encoding="utf-8")
    self.assertIsNone(FORBIDDEN.search(prompt))
    for phrase in (
        "greatest attempt number", "UNOWNED", "excluding skips",
        "half-up rounding", "exact unrounded failure ratio",
        "BEGIN_RESULT_JSON", "END_RESULT_JSON", "one-decimal string",
        "Do not modify the input files",
    ):
        self.assertIn(phrase, prompt)
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run `python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_protocol.py' -v`. Expected: the existing prompt lacks the new contract.

- [ ] **Step 3: Replace the prompt with the exact approved prompt**

Copy the prompt from the design document without Markdown fences. Do not paraphrase it.

- [ ] **Step 4: Add failing result-parser cases**

Test a valid marked array plus missing/duplicate markers, invalid JSON, extra keys, duplicate node IDs, boolean counts, numeric percentages, malformed one-decimal strings, wrong order, and Markdown/JSON disagreement.

- [ ] **Step 5: Implement strict parsing**

Parse into `object`, require the exact six keys, reject boolean/nonnegative-count errors, require `failure_percentage` to match `^[0-9]+\.[0-9]$`, preserve array order, and return stable differences for valid-but-incorrect reports.

- [ ] **Step 6: Run protocol tests and verify GREEN**

Run Step 2. Review the prompt directly and confirm forbidden terms remain absent. Do not commit.

---

### Task 3: Trace Adapters and Discovery Ordering

**Files:**

- Create: `tests/plugins/python-scripting/harness/trace_eval.py`
- Create: `tests/plugins/python-scripting/harness/test_trace_eval.py`
- Create: `tests/plugins/python-scripting/harness/fixtures/traces/claude-skill-before-write.jsonl`
- Create: `tests/plugins/python-scripting/harness/fixtures/traces/claude-inventory-only.jsonl`
- Create: `tests/plugins/python-scripting/harness/fixtures/traces/codex-skill-read-before-exec.jsonl`
- Create: `tests/plugins/python-scripting/harness/fixtures/traces/codex-silent-before-exec.jsonl`
- Create: `tests/plugins/python-scripting/harness/fixtures/traces/python-before-skill.jsonl`
- Create: `tests/plugins/python-scripting/harness/fixtures/traces/no-python.jsonl`
- Create: `tests/plugins/python-scripting/harness/fixtures/traces/combined-heredoc.jsonl`

**Interfaces:**

- `analyze_trace(host: Host, path: Path) -> TraceAnalysis`
- `is_python_action(tool_name: str, tool_input: object) -> bool`
- `classify_discovery(host, skill_events, python_actions, observable) -> Verdict`

- [ ] **Step 1: Write failing decision-table tests**

```python
def test_claude_skill_before_write_passes(self) -> None:
    result = analyze_trace(Host.CLAUDE, trace("claude-skill-before-write.jsonl"))
    self.assertEqual(result.discovery.state, VerdictState.PASS)

def test_no_python_always_fails(self) -> None:
    result = analyze_trace(Host.CODEX, trace("no-python.jsonl"))
    self.assertEqual(result.discovery.state, VerdictState.FAIL)

def test_silent_codex_with_python_is_unobservable(self) -> None:
    result = analyze_trace(Host.CODEX, trace("codex-silent-before-exec.jsonl"))
    self.assertEqual(result.discovery.state, VerdictState.UNOBSERVABLE)
```

Inventory-only mentions must fail. Evidence after the first Python action must fail.

- [ ] **Step 2: Run trace tests and verify RED**

Run `python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_trace_eval.py' -v`. Expected: missing module.

- [ ] **Step 3: Normalize host events**

Create immutable `NormalizedEvent(position, event_id, tool_name, input, output)` and `Evidence(position, event_id, kind, detail)`. Normalize Claude `assistant.message.content[].tool_use` and Codex resource/tool events. Reject malformed JSONL with its line number. Never treat initial skill inventory as evidence.

- [ ] **Step 4: Detect every Python construction/execution form**

Cover `.py` writes/edits/patches, heredocs, redirections, `python`, `python3`, versioned and absolute interpreters, `env` wrappers, `-c`, `-m`, stdin, `.py` execution, and one command that writes and runs. Use `shlex` plus conservative compound-shell fallback. Add a negative prose-only case.

- [ ] **Step 5: Capture auditable source and commands**

Capture full Write bodies, added-file patches, heredoc bodies, and `-c` bodies. Treat unreconstructable partial edits as `UNOBSERVABLE` unless a later full write or post-run snapshot supplies the source.

- [ ] **Step 6: Run trace tests and verify GREEN**

Run Step 2 and inspect each raw fixture against its expected event order. Do not commit.

---

### Task 4: Compliance Evaluator

**Files:**

- Create: `tests/plugins/python-scripting/harness/compliance.py`
- Create: `tests/plugins/python-scripting/harness/test_compliance.py`

**Interfaces:**

- `inspect_source(source: str, stdlib_modules: AbstractSet[str]) -> tuple[Finding, ...]`
- `inspect_commands(commands: Sequence[CapturedCommand]) -> tuple[Finding, ...]`
- `evaluate_probe(events: Sequence[NormalizedEvent]) -> ProbeResult`
- `evaluate_compliance(inputs: ComplianceInputs) -> Verdict`

- [ ] **Step 1: Write failing AST tests**

Test missing annotations, bare annotation containers, `Any`, `cast`, ignores, non-stdlib imports, `shell=True`, `tempfile.mktemp()`, and an untyped JSON root. Confirm inferred local containers are allowed.

```python
def test_rejects_incomplete_signature(self) -> None:
    findings = inspect_source("def load() -> list[dict]: ...", STDLIB)
    self.assertFinding(findings, "bare-container-annotation")
```

- [ ] **Step 2: Write failing command/manifest tests**

Reject fixed `/tmp/helper.py`, unquoted heredocs, shell-expanded dynamic values in Python source, package installation, network commands, project scaffolding, environments, caches, and leftovers. Accept `mktemp`, `mktemp -d`, `TemporaryDirectory`, separately passed arguments, unchanged inputs, and cleanup.

- [ ] **Step 3: Write failing malformed-probe tests**

Require the same helper to run against a copied input containing a boolean attempt or unknown outcome, with concise stderr and nonzero exit. Reject traceback-only failure, real-fixture mutation, or missing input hash evidence.

- [ ] **Step 4: Run compliance tests and verify RED**

Run `python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_compliance.py' -v`. Expected: missing module.

- [ ] **Step 5: Implement mechanical findings**

Parse source using `ast`; compare import roots to the tested interpreter's `sys.stdlib_module_names`; scan captured commands and baseline/post-run manifests. Use stable string finding codes including `missing-annotation`, `bare-container-annotation`, `dynamic-typing-escape`, `non-stdlib-import`, `shell-true`, `unsafe-tempfile`, `source-interpolation`, `package-install`, `project-scaffold`, `workspace-leftover`, and `probe-failure`.

- [ ] **Step 6: Implement verdict composition**

Mechanical findings produce `FAIL`; hidden required evidence produces `UNOBSERVABLE`. Require reviewed booleans plus notes for `proportionate_helper` and `sound_typed_narrowing`. Human review cannot override a mechanical failure.

- [ ] **Step 7: Run compliance tests and verify GREEN**

Run Step 4. Compare each rule with `python-simple-scripts/SKILL.md` and remove non-normative style preferences. Do not commit.

---

### Task 5: Isolated Host Runners and Outcome Matrix

**Files:**

- Create: `tests/plugins/python-scripting/harness/prepare_run.py`
- Create: `tests/plugins/python-scripting/harness/run_host.py`
- Create: `tests/plugins/python-scripting/harness/evaluate_run.py`
- Create: `tests/plugins/python-scripting/harness/test_prepare_run.py`
- Create: `tests/plugins/python-scripting/harness/test_run_host.py`
- Create: `tests/plugins/python-scripting/harness/test_evaluate_run.py`

**Interfaces:**

- `prepare_run(repo_root: Path, output_root: Path | None) -> RunLayout`
- `build_claude_command(layout: RunLayout, model: str) -> tuple[str, ...]`
- `build_codex_command(layout: RunLayout, model: str) -> tuple[str, ...]`
- `run_host(host: Host, layout: RunLayout, model: str) -> CompletedRun`
- `evaluate_run(layout, host, trace_path, final_response) -> EvaluationReport`

- [ ] **Step 1: Write failing layout and policy tests**

Assert three distinct unpredictable directories, only generated files in the agent workspace, only `python-scripting` in the staged marketplace, hidden evaluator/oracle, and pre-run hashes. Assert Codex config has `:minimal` read, only workspace write, absolute denies for repository/evaluator/staged/CODEX_HOME, network disabled, secret-free shell allowlist, and no legacy sandbox keys.

- [ ] **Step 2: Write failing command/secret tests**

```python
self.assertLess(command.index("--ask-for-approval"), command.index("exec"))
self.assertIn("--strict-config", command)
self.assertIn("--skip-git-repo-check", command)
self.assertNotIn("--sandbox", command)
```

With fake CLIs, assert Codex credentials travel only on login stdin, the agent environment lacks both credential variables, temporary `CODEX_HOME` is used, and no user auth path is opened.

- [ ] **Step 3: Write failing Claude isolation tests**

Render a `sandbox-exec` profile that permits required runtime reads, staged plugin reads, workspace writes, and parent network access; denies repository/evaluator/unrelated home reads and `/usr/bin/security`. Smoke-test allowed workspace access and denied sentinels. Build Claude with `--setting-sources project,local`, staged `--plugin-dir`, no session persistence, stream JSON, and only `Read,Glob,Grep,Bash,Write,Edit,Skill`.

- [ ] **Step 4: Run runner tests and verify RED**

```bash
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_prepare_run.py' -v
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_run_host.py' -v
```

Expected: missing modules.

- [ ] **Step 5: Implement preparation and isolation smoke gates**

Use `TemporaryDirectory(prefix="python-scripting-eval-")`; copy rather than symlink the plugin; create deny-test sentinels; generate fixture/oracle/manifests; render host policies; and record plugin, revision, CLI, model, instructions, and schema metadata. Mark the run `INVALID` if any forbidden sentinel is readable.

- [ ] **Step 6: Implement host execution**

Codex: install the staged marketplace/plugin into temporary `CODEX_HOME`, login via stdin, unset credentials, run strict doctor validation, smoke-check `exec --help`, then invoke global flags before `exec --ephemeral --skip-git-repo-check --json -`.

Claude: use keychain authentication, launch through the verified sandbox with `--setting-sources project,local`, staged plugin, Sonnet 5, and no session persistence. Invalidate if init metadata lists a non-built-in plugin other than `python-scripting`.

All subprocesses use argument arrays and `shell=False`; parent stdout redirection writes JSONL only to evaluator storage.

- [ ] **Step 7: Write failing outcome-matrix tests**

Cover harness `VALID/INVALID` and every discovery/compliance `PASS/FAIL/UNOBSERVABLE` combination. Require reasons for every non-pass. A correct no-Python result fails discovery; silent Codex loading with Python is unobservable; any oracle mismatch fails compliance.

- [ ] **Step 8: Implement canonical evaluation JSON**

Include metadata, hashes, discovered skills, first Python action, helper digest, protocol differences, mechanical findings, probe result, semantic notes, and:

```json
{
  "validity": {"state": "VALID", "reasons": []},
  "discovery": {"state": "PASS", "reasons": []},
  "compliance": {"state": "PASS", "reasons": []}
}
```

- [ ] **Step 9: Run all harness tests and verify GREEN**

```bash
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_*.py' -v
```

Inspect fake-run traces and environments for leaked credentials and forbidden paths. Do not commit.

---

### Task 6: Documentation, Structural Integration, and Real Runs

**Files:**

- Modify: `tests/plugins/python-scripting/test-incidental-helper.md`
- Modify: `tests/plugins/python-scripting/instructions.md`
- Modify: `tests/plugins/python-scripting/index.md`
- Modify: `tests/plugins/python-scripting/test-results.md`
- Modify: `tests/plugins/python/test_python_plugins.py`
- Delete: `tests/plugins/python-scripting/fixtures/incidental-helper/owners.json`
- Delete: `tests/plugins/python-scripting/fixtures/incidental-helper/artifacts/run-01.json` through `run-08.json`

- [ ] **Step 1: Write failing structural tests**

Assert all eight harness modules exist, old static fixture does not, instructions name Sonnet 5 and `gpt-5.6-terra`, temporary `CODEX_HOME`, strict config, skip-git flag, and separate verdicts.

- [ ] **Step 2: Run structural test and verify RED**

```bash
python3 -B -m unittest discover \
  -s tests/plugins/python \
  -p 'test_python_plugins.py' -v
```

Expected: failure because the old fixture/documentation remain.

- [ ] **Step 3: Rewrite rubric and instructions**

Document the exact prompt/schema, accepted host evidence, decision tables, compliance codes, malformed probe, semantic fields, secure preparation, noninteractive commands, interactive equivalents, retained evidence location, and reevaluation command.

- [ ] **Step 4: Remove old fixture after generator/oracle GREEN**

Delete only the nine obsolete fixture files listed above. Confirm version control can recover them.

- [ ] **Step 5: Run local validation**

```bash
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_*.py' -v
python3 -B -m unittest discover -s tests/plugins/python -p 'test_python_plugins.py' -v
claude plugin validate plugins/python-scripting
git diff --check
```

Expected: all tests pass; plugin validation has only the pre-existing optional-version warning; diff check is silent.

- [ ] **Step 6: Run real Claude Sonnet 5 evaluation**

Confirm init metadata shows only staged `python-scripting`; record validity, discovery, compliance, skill ordering, findings, probe, and semantic review in `test-results.md`.

- [ ] **Step 7: Run real Codex `gpt-5.6-terra` evaluation**

Confirm temporary install, strict doctor gate, credential redaction, trace observability, and full outcome matrix; record the result.

- [ ] **Step 8: Final verification and review checkpoint**

Repeat Step 5, search retained evidence for credential-like values and forbidden absolute paths, and confirm no cache, helper, temporary home, environment, or project scaffold remains in the repository. Report any `UNOBSERVABLE` result honestly. Do not commit or install packages.

---

## Deferred Follow-up: Apple Python 3.9 `unittest` Invocation

This is a separate future task, not part of the incidental-helper harness implementation.

- Reproduce `/usr/bin/python3 -m unittest tests/plugins/python/test_python_plugins.py -v` under Apple Python 3.9 and confirm the slash path is interpreted as a module name.
- Add a failing macOS-skill test for the documented command.
- Change the macOS guidance to a Python-3.9-compatible form, preferably:

```bash
/usr/bin/python3 -m unittest discover \
  -s tests/plugins/python \
  -p 'test_python_plugins.py' -v
```

- Verify the direct shell exit and test output separately from wrapper noise such as `(eval):5: parse error near 'end'`.
- Run the macOS skill's model-verification loop if its edited `SKILL.md` contains a `model:` frontmatter field.

## Final Acceptance Commands

```bash
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_*.py' -v
python3 -B -m unittest tests/plugins/python/test_python_plugins.py -v
claude plugin validate plugins/python-scripting
git diff --check
```

Expected final state: deterministic snapshots; all local tests green; recorded Claude Sonnet 5 and `gpt-5.6-terra` validity/discovery/compliance matrices; no leaked credential, hidden path, helper, cache, temporary home, or project scaffold; and no commit or installation without explicit authorization.
