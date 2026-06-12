# deep-planning Tests

Tests for the `deep-planning` plugin.

## Overview

No tests exist yet. The deep-planning plugin has only a `plugin.json` — no skill files
have been created yet.

**Plugin location:** `plugins/deep-planning/`

## Test Files

None yet.

## Suggested Test Approach

The deep-planning skill is intended for long-horizon project planning. Once skill files
are created, good test scenarios would verify:

- Given a project spec, does the agent produce appropriate phasing and task breakdown?
- Are dependencies between phases correctly identified?
- Does the agent produce a realistic timeline and milestone structure?

## How to Add Tests

1. Once SKILL.md files exist in `plugins/deep-planning/skills/`, create a `tests/` directory
2. Add `scenarios.md` following the pattern in existing plugins
3. Run RED and GREEN passes and record results

**Record results in:** [test-results.md](test-results.md)
