# Running the isolated python-scripting evaluation

Run local checks from the repository root. Use `-B` so validation does not add
bytecode caches to the checkout.

```bash
python3 -B -m unittest discover -s tests/plugins/python-scripting/harness -p 'test_*.py' -v
python3 -B -m unittest discover -s tests/plugins/python -p 'test_python_plugins.py' -v
claude plugin validate plugins/python-scripting
git diff --check
```

The Claude validator may emit the pre-existing optional-version warning for
`plugins/python-scripting/.claude-plugin/plugin.json`; record it separately
from test failures. Codex manifest and inventory checks live in the structural
test because Codex has no equivalent plugin-validation command.

## Harness preparation

The canonical reproducible evaluation path is the harness CLI. Choose an
existing output directory outside the repository and run:

```bash
python3 -B tests/plugins/python-scripting/harness/evaluate_run.py run --host codex --model gpt-5.6-terra --output-root <outside-repo>
```

The CLI creates the generated agent workspace, staged single-plugin
marketplace, and evaluator workspace; runs the host once; writes an incomplete
semantic-review template; and retains a complete evidence bundle at
`<outside-repo>/python-scripting-evidence-*`. The command prints that bundle's
`evaluation.json` path. The bundle contains `retained-bundle.json`, the
generated `agent-workspace`, the copied `staged-marketplace`, the evaluator
artifacts, the trace, and their immutable hashes and run bindings. It excludes
and cleans its temporary `CODEX_HOME`. Do not replace this path with a manually
prepared fixture, direct Codex chat, or a hand-composed `RunLayout` sequence.

| Exit status | Meaning |
| --- | --- |
| exit 0 | Valid run with both Discovery and Compliance `PASS` |
| exit 1 | Valid run, but Discovery or Compliance is not `PASS` |
| exit 2 | Command-line usage error |
| exit 3 | `INVALID` harness run |
| exit 70 | Harness orchestration or evidence-retention failure |

Before any model call, confirm all of the following:

- only the staged `python-scripting` plugin is enabled and its copied content
  hash, repository revision, enabled skills, prompt source, CLI version, seed,
  schema, manifest hash, baseline hash, and timestamps are recorded;
- the agent workspace contains generated `owners.json` and 32 artifacts only;
  the prompt, oracle, rubric, baseline hashes, evaluator data, and checkout
  are inaccessible to it;
- manifests use no-follow regular-file handling and later prove that inputs are
  unchanged and no helper, cache, environment, report, metadata, dependency,
  or other leftover remains; and
- evaluator evidence remains outside the agent workspace. Retain its
  `run-metadata.json`, `run-status.json`, `host-evidence.json`, trace,
  `evaluation.json`, hashes, source/command/probe captures, and
  `semantic-review.json` in approved secure storage for audit, then clean up
  the harness-owned temporary roots when retention is no longer required.

## Codex: gpt-5.6-terra

Automated Codex evaluation uses a newly created, empty temporary `CODEX_HOME`;
it never reads, copies, or modifies a user's Codex home. The harness stages a
marketplace containing only `python-scripting`, installs it into that temporary
home, and writes the restrictive `config.toml` there. Its manifest is staged at
`staged-marketplace/.agents/plugins/marketplace.json`, the path required by the
Codex marketplace CLI. The prepare-run suite includes a credential-free
marketplace smoke that uses another temporary `CODEX_HOME` to execute real
`marketplace add`, `plugin add`, and `plugin list` commands against that staged
copy without a model call, login, user-home access, or network. The profile
reads only the minimum runtime and writes only the agent workspace; it
explicitly denies the repository, evaluator workspace, staging root, and
`CODEX_HOME`, disables network, uses `inherit = "none"`, and allows only `PATH`,
`HOME`, `LANG`, and `PYTHONNOUSERSITE`.

Within that canonical command, the recorded noninteractive host invocation has
this shape (absolute paths are rendered by the harness, not copied into this
document):

```text
env CODEX_HOME=<temporary-home> codex --strict-config --ask-for-approval never \
  -C <agent-workspace> --model gpt-5.6-terra exec --ephemeral \
  --skip-git-repo-check --json -
```

Do not add legacy `--sandbox` or `--add-dir`, and do not move global flags
after `exec`: the `--strict-config` gate and `--skip-git-repo-check` flag are
required. The harness first requires `codex --strict-config doctor --json`
and a global-flags-plus-`exec --help` smoke test. It authenticates only when
exactly one supported environment credential is already present
(`OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN`), sending it only to the matching
stdin login; tracing is disabled, both variables are removed before agent
execution, and all artifacts are redacted/scanned. Never inspect a user auth
file to satisfy this prerequisite.

There is no supported interactive substitute for a scored Codex result: an
interactive chat cannot guarantee the isolated workspace, temporary home,
strict doctor gate, full trace, and evaluator binding. For diagnosis only, a
maintainer may inspect the retained `python-scripting-evidence-*` directory;
do not turn an interactive response into a recorded pass/fail result.

## Claude Sonnet 5

The intended model label is Claude Sonnet 5. Its command shape preserves the
staged plugin, exact tool allowlist (`Read,Glob,Grep,Bash,Write,Edit,Skill`),
strict MCP configuration, stream JSON, no persistence, and project/local
setting sources. The corresponding interactive equivalent would be a fresh,
staged-plugin session that receives only the exact prompt and exposes its tool
trace; it is not an accepted evaluation today.

Current outcome: **do not launch Claude Sonnet 5 for this harness.** The
parent-only Seatbelt profile cannot enforce network denial for Bash descendants,
so the runner records `INVALID` before any model execution. Unit tests exercise
the smoke behavior with fake executables, but the real nested Seatbelt profile
smoke is skipped in this managed environment. No live Claude evaluator artifact
or retained smoke evidence exists here. A live Claude result may only be
recorded after the host supplies a separately sandboxed shell or network broker
that satisfies the isolation boundary.

## Review, results, and reevaluation

Read `test-incidental-helper.md` before reviewing an evaluation. Record
Validity, Discovery, and Compliance as separate reason-bearing outcomes, plus
accepted skill events/order, first Python action, protocol differences,
mechanical findings, malformed-probe evidence, manifests, cleanup, and the
two semantic-review fields. `UNOBSERVABLE` means evidence is hidden or absent;
it is never permission to infer success.

After `run`, edit only the retained bundle's `semantic-review.json`. Set
`approved` to `true` or `false` for both `proportionate_helper` and
`sound_typed_narrowing`, and provide nonempty reviewer `notes` for each. Missing
approval or notes keeps Compliance `UNOBSERVABLE`; a rejection makes it `FAIL`.
Then run the real deterministic evaluator over the retained evidence:

```bash
python3 -B tests/plugins/python-scripting/harness/evaluate_run.py reevaluate --evidence <outside-repo>/python-scripting-evidence-*
```

`--evidence` may name the bundle directory or its `evaluation.json`. Before
evaluation, the CLI verifies immutable-file hashes, safe paths, the retained
trace, fixture manifest, baseline, host, and run bindings. It then extracts the
recorded final response, reruns the actual evaluator, and updates the bundle's
`evaluation.json`; it does not invoke a model, log in, or use a credential. Any
changed immutable evidence causes exit 70 and leaves the prior evaluation in
place. Use the four local commands above for code reevaluation.
To obtain a new model sample, use `run` with a fresh outside-repository output
root and exactly one supported environment credential; never substitute an old
session or an unbound trace.
