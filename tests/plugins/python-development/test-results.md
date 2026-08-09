# python-development Test Results

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-08-08 | Project tooling | Baseline: FAIL | Silently selected Python 3.12 and mypy rather than resolving the version and using the agreed new-project defaults. |
| 2026-08-08 | Type-tightening scope | Baseline: PASS | Correctly limited work to changed files and necessary interfaces. |
| 2026-08-08 | Python testing | Baseline: PASS | Already covered unit/integration boundaries, malformed data, invariants, and sensible mocking. |
| 2026-08-08 | Typing variance reference | Baseline: PASS | Correctly explained invariant lists and covariant read-only sequences. |
| 2026-08-08 | Async concurrency | Baseline: PASS | Correctly used TaskGroup, a semaphore, per-request timeout, and cancellation propagation. |
| 2026-08-08 | Dignified production design | GREEN: PASS (independent) | Asked for the version, offered 3.14, inspected conventions, and loaded API/exception references selectively. |
| 2026-08-08 | Project tooling | GREEN: PASS (independent) | Asked first, proposed 3.14, uv/Ruff/ty/pytest, conditional Hatchling, clean builds, and trusted publishing. |
| 2026-08-08 | Type-tightening scope | GREEN: PASS (independent) | Applied the pinned workflow to changed files and necessary interfaces with existing commands and no broad churn. |
| 2026-08-08 | Python testing | GREEN: PASS (independent) | Covered public behavior, malformed data, real filesystem integration, conditional invariants, and narrow mocking. |
| 2026-08-08 | Typing variance reference | GREEN: PASS (independent) | Consulted and named the vendored spec, separated normative rules, and recommended `Sequence` for read-only APIs. |
| 2026-08-08 | Async concurrency | GREEN: PASS (independent) | Used a bounded worker pool, TaskGroup, per-request timeout, propagated cancellation, and explained ExceptionGroup. |
| 2026-08-09 | Existing repository toolchain | New scenario: NOT RUN | Moved from python-scripting after the routing boundary was split; independent evaluation remains pending. |
