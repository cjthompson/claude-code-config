---
name: python-testing
description: Design and implement robust Python tests with pytest, including unit and integration boundaries, fixtures, parametrization, failure cases, and optional property-based tests. Use when adding tests, repairing a test suite, or deciding how Python behavior should be verified.
---

# Python Testing

First inspect the repository's test configuration, conventions, and commands. Keep its runner and plugins unless the user asks for a migration.

## Choose the boundary

- Unit-test pure decisions and transformations through public behavior.
- Integration-test filesystem, database, process, network, serialization, and framework seams with the smallest realistic boundary.
- Add a regression test that fails for the reported bug before changing production code.
- Do not mock the unit under test. Prefer fakes or narrow mocks at slow or nondeterministic boundaries.

## Build useful cases

- Cover the happy path, empty and boundary values, malformed input, and expected failures.
- Parametrize variations that share one behavior; use separate tests when the reason for failure differs.
- Keep fixtures local, explicit, and immutable where practical. Use `tmp_path`, `monkeypatch`, and context-managed resources.
- Assert observable values, state, and important effects. Avoid snapshots of incidental formatting or internal call order.
- Use Hypothesis when a behavior is naturally described by invariants across a broad input space and the project already permits it.

## Verify

Run the narrowest affected tests first, then the repository's full required test command. Report the exact commands and any tests you could not run.
