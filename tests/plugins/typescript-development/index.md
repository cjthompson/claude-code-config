# typescript-development Tests

This directory combines deterministic compiler-backed tests with behavioral evaluations for all six skills.

## Automated checks

```bash
node --test \
  tests/plugins/typescript-development/structure.test.mjs \
  tests/plugins/typescript-development/sync-typescript-references.test.mjs \
  tests/plugins/typescript-development/compiler-fixtures.test.mjs
node plugins/typescript-development/scripts/sync-typescript-references.mjs --check
```

The compiler suite covers strict positive and expected-error cases, NodeNext and bundler resolution, declaration emit, package exports from an installed fixture, and composite project references.

## Behavioral method

Run each prompt in `scenarios.md` with `gpt-5.6-terra` in a fresh, read-only, ephemeral context:

1. Baseline: do not provide the new skill.
2. GREEN: provide the full named `SKILL.md` and the same prompt. For the reference scenario, also provide the topic index and selected official pages.
3. Preserve the responses in `baseline-responses.md` and `green-responses.md`.
4. Give both responses and the scenario criteria to `gpt-5.6-luna` without identifying which response is baseline or GREEN. Record its verdict in `judge-report.md`.

Behavioral evaluations advise skill quality; automated tests remain the reproducible acceptance gate.
