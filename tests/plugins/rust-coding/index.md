# rust-coding Tests

Tests for the `rust-coding` plugin skill.

## Overview

No tests exist yet for the rust-coding skill.

**Skill location:** `plugins/rust-coding/skills/rust-coding/SKILL.md`

## Test Files

None yet. The skill directory has no `tests/` subdirectory.

## Suggested Test Approach

The rust-coding skill guides agents toward idiomatic Rust patterns. Good test scenarios
would exercise:

| Scenario Type | What to Verify |
|---------------|----------------|
| Data structure choice | Agent picks struct vs enum vs newtype correctly |
| Trait placement | Implements traits on the right type in the right module |
| Ownership patterns | Borrows, clones, and Arc/Mutex usage are appropriate |
| Error handling | Uses `Result` and `?` operator rather than `unwrap` in library code |
| Documentation | Adds doc comments to public API items |

## How to Add Tests

1. Create `plugins/rust-coding/skills/rust-coding/tests/`
2. Add `scenarios.md` following the pattern in `plugins/agent-team-development/skills/agent-team-development/tests/scenarios.md`
3. Run a haiku subagent with each scenario (without skill) → `baseline-results.md`
4. Re-run with SKILL.md prepended → `green-results.md`

**Record results in:** [test-results.md](test-results.md)
