# Tests

This directory mirrors the structure of `plugins/` and `packages/`. Each subdirectory
contains an `index.md` explaining the test approach for that component, and a
`test-results.md` for tracking execution history.

## Testing Paradigms

Two testing paradigms are used in this repo:

### 1. Skill Scenario Tests (LLM Evaluation)
Used for plugins. Tests are prose-based scenario documents evaluated manually by
dispatching a Claude subagent.

**Process:**
1. Write scenarios in `plugins/<name>/skills/<name>/tests/scenarios.md`
2. Dispatch a haiku subagent with only the scenario text (no skill) → record in `baseline-results.md` (RED phase)
3. Re-run the subagent with the SKILL.md prepended → record in `green-results.md` (GREEN phase)
4. Tests pass when GREEN results address all gaps from the baseline

### 2. Automated Unit Tests
Used for packages. Tests are TypeScript/JavaScript files run via Node.js `node:test`, living
in `tests/packages/<name>/` rather than the package directory itself — so a package's test
source can never end up in the installed/published output, independent of (and in addition
to) whatever install-time file allowlist that package's own `manifest.json` uses.

**Run statusline tests:**
```bash
node --experimental-strip-types --test tests/packages/statusline/statusline-render.test.mts
```

No other packages have automated tests yet.

## Plugins

| Plugin | Test Type | Status | Index |
|--------|-----------|--------|-------|
| agent-team-development | Scenario-based (7 scenarios) | Has tests | [index.md](plugins/agent-team-development/index.md) |
| lean-agents | Scenario-based (8 scenarios, 3-pass) | Has tests | [index.md](plugins/lean-agents/index.md) |
| orchestration-strategy | Scenario-based (7 scenarios) | Has tests | [index.md](plugins/orchestration-strategy/index.md) |
| project-tasks | Scenario-based + individual test files | Has tests | [index.md](plugins/project-tasks/index.md) |
| rust-coding | Scenario-based | No tests yet | [index.md](plugins/rust-coding/index.md) |
| textual | Scenario-based (reference skill) | No tests yet | [index.md](plugins/textual/index.md) |
| deep-planning | Scenario-based | No tests yet | [index.md](plugins/deep-planning/index.md) |

## Packages

| Package | Test Type | Status | Index |
|---------|-----------|--------|-------|
| statusline | Automated unit tests (node:test) | Has tests | [index.md](packages/statusline/index.md) |
| installer | — | No tests yet | [index.md](packages/installer/index.md) |
| output-styles | — | No tests yet | [index.md](packages/output-styles/index.md) |
| task-db | Automated unit tests (node:test) | Has tests | [index.md](packages/task-db/index.md) |

## Adding New Tests

**For a plugin skill:**
1. Create `plugins/<name>/skills/<name>/tests/` if it doesn't exist
2. Add `scenarios.md` following the pattern in `plugins/agent-team-development/skills/agent-team-development/tests/scenarios.md`
3. Run RED + GREEN passes and record results
4. Update the plugin's `index.md` here in `tests/`

**For a package:**
1. Add a `.test.mts` file in `tests/packages/<name>/` (not the package directory itself)
2. Use `node:test` and `node:assert` following `tests/packages/statusline/statusline-render.test.mts` as a reference — note it imports the module under test via a relative path back into `packages/<name>/`, since the two directories are siblings under the repo root, not nested
3. Update the package's `index.md` here in `tests/`
