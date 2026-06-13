# textual Test Results

Tracks test execution history for the textual plugin.
For test scenarios, see:
- [test-textual-css-reference.md](test-textual-css-reference.md)
- [test-textual-api-reference.md](test-textual-api-reference.md)

## Execution Log

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-06-12 | CSS display property — only two valid values | Baseline: PASS / GREEN: PASS | ⚠️ Baseline passed — not a discriminating scenario for Sonnet 4.6. |
| 2026-06-13 | CSS grid layout — correct property names | Baseline: PARTIAL / GREEN: FAIL | ⚠️ Two test design bugs found and fixed: MUST #3 (grid-rows) not triggered by column-only prompt; MUST NOT too strict (flagged mentions of wrong property even when labelled as invalid). Scenario updated; re-run needed. |
