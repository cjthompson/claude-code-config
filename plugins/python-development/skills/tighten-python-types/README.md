# Evaluation history

This file records why `tighten-python-types` keeps a small operational
`SKILL.md` that explicitly reads the pinned upstream workflow. It is historical
evidence, not additional skill instructions.

## Layout comparison — 2026-08-08

Three layouts were tested on two identical type-tightening scenarios, with a
no-skill control. Each arm used a fresh agent at high reasoning and had to edit
an isolated project, run its unit tests and `ty check`, stay within the changed
files, and report retained uncertainty.

- **X — referenced:** the current 208-word wrapper reads the 1,438-word
  vendored workflow.
- **Y — direct:** the unmodified vendored file is renamed to `SKILL.md`.
- **Z — inlined:** local constraints and the vendored workflow are combined in
  one 1,544-word `SKILL.md`.

The experiment ran once with `gpt-5.6-luna` and once with `gpt-5.6-terra`.
The referenced layout opened the vendor file in all four applicable runs.

| Model | Notable results |
|-------|-----------------|
| Luna | A blinded human ranking was Z, then X, then Y, with all three close. Y retained one avoidable `Any`; X and Z stayed in scope and passed all checks. |
| Terra | Y was behaviorally strongest. Z retained avoidable `Any` at a validated boundary. X made correct target-file changes but also edited two out-of-scope files. |

All scored arms passed their runtime tests and `ty` checks. One initial Terra Y
run refused the temporary fixture path before editing; it was discarded and
repeated in a fresh context with explicit path provenance.

## Operational findings

The direct layout is not deployable unchanged: its upstream frontmatter sets
`disable-model-invocation: true`, preventing normal Claude auto-invocation and
failing Codex plugin validation. The referenced and inlined layouts validate.

## Decision

Retain the referenced layout. It reliably loaded the vendor file, preserved
clean upstream provenance, and showed no stable quality disadvantage across
models. The small sample does not establish a universal ranking. Re-run the
comparison after material skill or model changes, or if agents begin skipping
the referenced workflow.
