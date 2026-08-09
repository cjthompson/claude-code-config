# Python Scripting and Development Plugins

> Recovered from Codex session `019fe3fe-5b57-7531-be98-ff08a032df80`, final proposed plan at ordinal 497.

## Implementation Status — 2026-08-09

This status was checked against the live checkout. The implementation is
complete and committed on `feat/python-scripting-development-plugins` at
`a167ef6` (`feat(python): complete scripting and development plugins`). The
branch is four commits ahead of `origin/main`, zero behind, and has not been
pushed or merged. This plan-status edit is the only change after that commit.

### Completed and committed

- [x] The independently installable `python-scripting` and
  `python-development` plugins have aligned Claude, Cursor, and Codex
  manifests, a repository-local Codex marketplace, scoped installation
  documentation, and a single ty LSP configuration owned by
  `python-scripting`.
- [x] `python-simple-scripts` replaces the earlier `python-coding` proposal and
  explicitly covers shell-invoked and incidental helpers. Standalone quality
  tools remain under `python-scripting`, while established project toolchains
  route to `python-development`.
- [x] The complete skill inventory and one-way optional handoffs are present.
  The pinned Honnibal workflow, all 27 typing-specification files, licenses,
  hashes, topic index, and dependency-free synchronization and offline
  verification utility are included.
- [x] All six tasks in the follow-on incidental-helper plan are implemented:
  deterministic fixtures and oracle, exact protocol parsing, Claude/Codex
  trace normalization, discovery and compliance evaluation, isolated host
  preparation, evidence retention and reevaluation, structural integration,
  and the manual runbook. The obsolete static fixture was removed.
- [x] Final verification ran 153 harness tests (152 passed and one expected
  managed-Seatbelt skip), 11 structural tests, 7 typing-sync tests, the
  repository TypeScript typecheck, and `ty` across the harness. Both Claude
  plugin validations passed with only the pre-existing optional-version
  warning. All harness files parse under Python 3.11 grammar.
- [x] A credential-free Codex CLI 0.147.0 smoke successfully added the staged
  marketplace, installed the staged plugin, and listed it using a temporary
  `CODEX_HOME`, without login, model execution, network access, or user-home
  access.
- [x] Generated cache artifacts were excluded. Repository metadata is aligned
  at version `0.0.62` in `package.json`, both lockfile locations, and
  `CHANGELOG.md`.

### Remaining acceptance and integration work

- [ ] Run and independently evaluate the revised standalone-quality-tools
  scenario and the existing-repository-toolchain scenario; both remain
  explicitly recorded as `NOT RUN` in their plugin result logs.
- [ ] Run the live Codex `gpt-5.6-terra` evaluation when exactly one supported
  credential is intentionally supplied, retain the complete evidence bundle,
  and complete the required human semantic review.
- [ ] A live Claude evaluation cannot currently produce a valid result. The
  harness fails closed because one macOS Seatbelt profile cannot grant network
  only to the Claude parent while denying it to Bash descendants. A separately
  sandboxed shell or network broker is required before that matrix can run.
- [ ] Push and review `feat/python-scripting-development-plugins`, then merge it
  when accepted. The separate `feat/codex-support` branch is not incorporated
  in this branch.
- [ ] Installation has not been run. After merge, ask whether to run
  `npm run install-packages` as required by the repository workflow.

## Summary

Split the current Python work into two independently installable plugins:

- `python-scripting`: low-token guidance enabled for routine scripts.
- `python-development`: deeper project-scale workflows enabled only where needed.

Both plugins must support Claude Code, Cursor where applicable, and Codex. A separate coordinated plan will port every other repository plugin to Codex.

## Plugin and Skill Structure

### `python-scripting`

- `python-coding`: concise, automatically invoked Python coding principles.
- `python-typing`: compact type-safe generation rules for ordinary scripts.
- `python-quality-tools`: run existing Ruff, formatter, and ty commands without creating project configuration.
- `macos-python-scripting`:
  - Use `#!/usr/bin/python3` and Python 3.9-compatible syntax.
  - Permit only standard-library imports.
  - Permit stable macOS executables through safe `subprocess` calls.
  - Never depend on package managers or site-packages.
  - Verify with `/usr/bin/python3 -E -s -S`.
- Own the sole ty LSP configuration to avoid duplicate language servers.

### `python-development`

- `dignified-python`: detailed production standards and version-aware guidance through Python 3.14.
- `python-testing`: pytest, fixtures, parametrization, boundary mocking, integration tests, async tests, and Hypothesis.
- `python-project-tooling`: uv, Ruff, ty, pytest, `pyproject.toml`, lockfiles, builds, wheels, sdists, and trusted publishing.
- `python-async-concurrency`: structured asyncio, cancellation, timeouts, synchronization, backpressure, threads, processes, and Python 3.14 concurrency.
- `python-typing-reference`: difficult typing semantics backed by the complete Python typing specification.
- `tighten-python-types`: systematic survey–analyze–edit–verify workflow for typing edits.

## Optional Cross-Skill Handoffs

- Keep all skills independently useful; neither plugin is a hard dependency of the other.
- Permit one-way optional escalation:
  - `python-typing` → `python-typing-reference` for difficult specification questions.
  - `python-typing` → `tighten-python-types` for cross-file annotation improvement.
  - `python-quality-tools` → `python-project-tooling` when configuration or migration is requested.
- Check whether the target skill is available before invoking it. Continue with local guidance when the deeper plugin is absent.
- Keep escalation targets model-invocable; do not use `disable-model-invocation: true` on skills that must be callable by another skill.
- Prevent cycles: development skills do not invoke scripting skills.
- Loading a deeper skill remains conditional, so its full body and references consume context only after handoff. [Claude skill loading and invocation](https://code.claude.com/docs/en/skills)

## Typing References

- Keep `python-typing` to approximately 60–100 lines of high-frequency rules:
  - Version-compatible annotation syntax.
  - Complete function signatures and mutable-state annotations.
  - Avoiding unjustified `Any`.
  - Validating external data at boundaries.
  - Choosing `TypedDict` or dataclasses without adding unnecessary runtime dependencies.
  - Explicit optional-value narrowing.
  - Avoiding speculative protocols, overloads, generics, casts, and ignores.
  - Running the existing checker and repairing root causes.
- Vendor the unmodified `tighten-types.md.txt` from `honnibal/claude-skills`, pinned to commit `882fe898acec52ddc39d074e12c7497ee96ed963`, with its MIT license and provenance.
- Apply `tighten-python-types` to every typing edit:
  - Use user-named paths when supplied.
  - Otherwise inspect changed Python files.
  - Preserve runtime behavior and public APIs.
  - Use the repository’s configured checker.
- Vendor all 27 RST files from `python/typing/docs/spec`, pinned to commit `fa0a78a67b2844561c0281f3b9e5eb9464e12750`, preserving exact contents and the PSF license.
- Give `python-typing-reference` a compact topic index that searches and loads only relevant specification files.
- Add a dependency-free sync utility that resolves immutable commits, validates the expected file inventory, records SHA-256 hashes, preserves licenses, updates atomically, and supports offline verification.

## Claude, Cursor, and Codex Distribution

- Give both plugins aligned `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, and `.codex-plugin/plugin.json` manifests.
- Codex manifests must include validated names, descriptions, authorship, license, keywords, skill paths, interface metadata, capabilities, and example prompts.
- Add both plugins to a repository Codex marketplace at `.agents/plugins/marketplace.json` with:
  - Relative local source paths.
  - `policy.installation: "AVAILABLE"`.
  - `policy.authentication: "ON_INSTALL"`.
  - Development category metadata.
- Preserve existing marketplace entries when updating the Codex marketplace so the separate repository-wide migration can add other plugins safely.
- Keep skill instructions host-neutral:
  - Refer to capabilities rather than Claude-only tool names.
  - Translate optional skill handoffs to the host’s available invocation mechanism.
  - Provide safe fallbacks when a host lacks a feature.
- Treat the ty LSP as a Claude/Cursor enhancement. Codex functionality uses the ty CLI and must not depend on Codex exposing an equivalent LSP component.
- Validate each Codex plugin with the Codex plugin validator and validate the marketplace schema. Do not read or modify installed copies under `~/.codex`.
- Document user-scope installation of `python-scripting` and project-scope installation of `python-development`. Official OpenAI documentation describes plugins as extending Codex with skills and related capabilities. [OpenAI Developers](https://developers.openai.com/)

## Test Plan

- Add behavioral scenarios for every skill, with unskilled and skill-enabled runs independently judged by `gpt-5.6-luna`.
- Test optional handoffs with the deep plugin available and unavailable.
- Test that ordinary script generation does not load project-scale guidance.
- Test typing generation, systematic tightening, and specification lookups separately.
- Test macOS scripts for Python 3.9 syntax, third-party import rejection, safe subprocess arguments, and execution without site-packages.
- Test upstream synchronization for missing files, unexpected files, hash mismatches, failed downloads, and atomic rollback.
- Validate all manifests, marketplace entries, skill frontmatter, references, licenses, LSP configuration, README instructions, and repository type checks.
- Confirm Claude, Cursor, and Codex metadata describe the same skill inventories and that the final diff contains no unrelated changes.

## Assumptions and Coordination

- Existing repositories retain their established Python tools without migration recommendations.
- New or intentionally modernized projects default to uv, Ruff, ty, and pytest.
- Python 3.14 is the project default when no version is declared; the macOS scripting skill targets Apple’s Python 3.9 environment.
- A separate plan will create functional Codex ports for every non-Python plugin and extend the shared Codex marketplace without changing these Python plugin contracts.
- Implementation stops before commit, merge, version bump, changelog update, installation, or modification of installed Codex configuration.
