# python-scripting tests

The incidental-helper evaluation is a deterministic, isolated harness rather
than a static fixture. Eight modules under `harness/` separate generation,
oracle, prompt protocol, trace normalization, compliance, preparation, host
launch, and evaluation. A retained evidence bundle preserves the evaluator
audit record, generated agent workspace, staged marketplace, trace, and their
bindings while the live agent receives only generated JSON inputs and the
neutral prompt.

Start with [the rubric](test-incidental-helper.md), then use
[the run instructions](instructions.md). Local regression checks are the
harness unittest discovery, the Python-plugin structural unittest discovery,
Claude plugin validation, and `git diff --check`.

The canonical live command is
`python3 -B tests/plugins/python-scripting/harness/evaluate_run.py run --host codex --model gpt-5.6-terra --output-root <outside-repo>`.
It retains a `python-scripting-evidence-*` bundle outside the checkout and
removes its temporary `CODEX_HOME`. After a human completes both fields in
`semantic-review.json`, rerun the real evaluator without another model call:
`python3 -B tests/plugins/python-scripting/harness/evaluate_run.py reevaluate --evidence <bundle>`.

The result log records outcomes by host/model. It distinguishes `INVALID`
harness runs from `PASS`, `FAIL`, and `UNOBSERVABLE` Discovery and Compliance
verdicts. It never treats an answer, skill inventory, or interactive chat as
evidence of discovery.
