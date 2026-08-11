# Changelog

## v0.0.64 - 2026-08-11

### Changes
- **output-styles**: added a banned-word rule to the top of both `concise` and `terse` styles, forbidding "load-bearing" (or "load bearing") in any reply.

## v0.0.63 - 2026-08-11

### Changes
- **statusline**: reworked terminal-width handling end to end. Removed the stale `RIGHT_RESERVE` right-margin reserve (Claude Code no longer renders anything in a right-aligned column) and its line-2 counterpart, a fixed `barWidth` threshold that shrank quota bars at `termWidth >= 120` regardless of whether the line actually needed the room — both were non-monotonic cliffs where widening the terminal by one column could drop more content. `fitSegments` now has a `priority` field (higher = kept longer) with a `PROTECTED_PRIORITY` floor instead of a `core` flag, and never drops model/context/branch/pwd down to nothing. Those four protected segments now shrink through their own tiers instead of vanishing or staying static: model (full name → first letter, e.g. `Sonnet 4.6` → `S`), context usage (four tiers: full → drop token count → drop bar → icon only), branch (three length tiers, replacing a blunt two-value cap), and the working directory's last path segment (new ellipsis truncation, shrinking only after everything above it is exhausted). Added `tests/packages/statusline/statusline-resize-sweep.mts`, a manual dev tool for rendering every width across a range to eyeball this behavior, and moved all statusline test source into `tests/packages/statusline/` so it can't ship as part of the installed package.

## v0.0.62 - 2026-08-09

### Changes
- **plugins/python-scripting**: documented portable Apple Python 3.9 `unittest` guidance: use dotted module names with `python -m unittest`, or use `unittest discover` with an explicit start directory and filename pattern when selecting tests by path. Added standalone structural regression coverage for the generic discovery command.

## v0.0.61 - 2026-08-06

### Changes
- **statusline**: `statusline.sh` no longer collapses every renderer failure into the fixed, misleading `Usage: parse error` text. It now captures the renderer's stdout/stderr separately, and on a non-zero exit logs the real exit code and stderr to `${XDG_STATE_HOME:-$HOME/.local/state}/claude/statusline-error.log` and shows `statusline: render failed (exit N) — see <log>` instead. A successful render's stdout is unaffected, and warnings the renderer intentionally discards (e.g. a bad `statusline-config.json`) still don't leak into the statusline text. This makes any future renderer failure diagnosable instead of a silent, unlabeled string.

## v0.0.60 - 2026-08-06

### Changes
- **statusline**: fixed a crash in `statusline-render.mts` where a `rate_limits` bucket (`five_hour`/`seven_day`) with usage but no `resets_at` yet caused `new Date(undefined * 1000).toISOString()` to throw `RangeError: Invalid time value`, uncaught. `statusline.sh` swallows the renderer's stderr and exit code, so this surfaced only as the generic, misleading statusline text `Usage: parse error`. The `resets_at` conversion is now guarded to fall back to `undefined` when the field is absent, matching what `buildQuotaLine` already handles. Added a regression test (`statusline-render.test.mts`).

## v0.0.59 - 2026-08-06

### Changes
- **repo**: the post-commit version-bump rule now names `package-lock.json` as a required step, in both `CLAUDE.md` and `AGENTS.md`. It previously listed only `package.json` and `CHANGELOG.md`, and the lockfile drifted on two consecutive bumps as a result — an independent review caught the `0.0.56`/`0.0.57` gap, then the `0.0.58` bump reintroduced it. The new step names both locations that need editing (top-level `version` and the root entry under `packages[""]`) and gives a one-line `grep` to verify before committing. Renumbered the following steps in both files. This commit follows the amended rule.

## v0.0.58 - 2026-08-06

### Changes
- **installer**: `enter` now always applies instead of being a no-op when nothing is toggled. With a pending selection it installs, with a pending removal it removes, and with neither it re-applies the packages already installed — a repair/confirm pass. The status line reflects which case applies (`↵ Install selected` / `↵ Apply removals` / `↵ Apply changes` / `↵ Re-apply / confirm`) and the footer hint changed from `enter install` to `enter apply`. This deliberately reverses the earlier gating design (`9ea7acc`, "InstallButton demoted to static status line (↵ Install / Nothing selected)"), where `enter` did nothing unless something was selected.
- **installer**: `installFiles` hash-compares source against destination before copying, so a re-apply reports `already up to date` rather than a misleading `Updated`, and does not rewrite the file. Verified by unchanged `mtime` across a re-apply. Side benefit: a destination that is a symlink into the repo is no longer clobbered with a real file copy, since the hash follows the link and matches. The `settings.json` merge already behaved this way; the file copy now matches it.
- **installer**: extracted the private `fileHash` helper from `lib/discover.ts` into `lib/hash.ts` so `lib/install.ts` can share it. No behavior change.
- **installer**: a run that finds nothing to do now reports "Nothing to do — no items selected." instead of an empty results screen.
- **installer**: recorded a `reapply-idempotency` manual test scenario and rewrote step 6 of `flat-checklist-navigation`, which asserted the now-removed "↵ Nothing selected" state. Also documented a **pre-existing** bug found while verifying: a files package whose items differ in install state (files present, `settings` key absent) removes and then immediately recopies itself, because `toggleItem` sets `markedForRemoval` without clearing `enabled`. Reproduces with this change reverted; fix belongs in `toggleItem` and is not attempted here.
- **repo**: synced `package-lock.json` to the current version. It recorded `0.0.57` at both the top-level and root-package entries while `package.json` said `0.0.58`, leaving committed npm metadata inconsistent and guaranteeing lockfile churn on the next `npm install`. This drift has now recurred across two consecutive bumps — an independent review caught the `0.0.56`/`0.0.57` instance, and the `0.0.58` bump reintroduced it — so the version-bump step needs to touch all three files, not two.

## v0.0.57 - 2026-08-03

### Changes
- **plugins/lean-agents**: fixed a broken escalation path — `main` and `standard-executor` were documented to spawn `full-executor` for `EnterPlanMode`/`ExitPlanMode`, but the harness blocks both tools inside any subagent regardless of its `tools:` frontmatter (confirmed by a live runtime error: "ExitPlanMode is not available inside subagents"). Removed the false escalation promise from `main.md`, `standard-executor.md`, and the plugin's routing `CLAUDE.md`. Added a "Plan Mode Handoff" section to `main.md`: instead of escalating or assuming plan-mode-ending is approval, `main` now ends its turn with a plain statement asking the user to exit plan mode and explicitly confirm before it runs any non-read-only tool. Added two new routing scenarios (`tests/scenarios.md`) covering this. No agent's `tools:` frontmatter changed — `full-executor` still lists the plan-mode tools as a harmless no-op for the untested case where it's run as a top-level session agent itself.
- **plugins/output-styles**: closed ten wording gaps in the Terse style that let a reply come back as markdown-free prose while formally breaking almost nothing. Label lead-ins are now caught whatever punctuation ends them (a period escaped the old colon/dash ban); one-fact-per-line can no longer be dodged by writing paragraphs instead of a labeled block; the detail menu applies after any answer, not just a brief one; labels must be short categories rather than sentences requoted in backticks, while verb-phrase labels like `Leave unchanged` stay legal; and the backtick rule is restated inside "Rules of the block" where facts actually get written.
- **plugins/output-styles**: banned first-person retrospective prose ("the key thing I'd been missing", "worth naming that I nearly…") — the largest single source of bloat in the sample reply, and previously uncovered by any rule.
- **plugins/output-styles**: added a required terminal `Result` block using the `✓`/`✗`/`○`/`●` status family, so a reply reports what has *not* happened instead of omitting it. `Result` is reserved for that block, and the old outcome-state rule folds into it rather than duplicating it.
- **plugins/output-styles**: acronyms must be expanded on first use, with an explicit `(expansion unknown)` form instead of passing a bare token through — an internal `MOD` went unexplained through an entire session, and inferring its meaning from context produced the wrong answer. Exemptions are a closed list plus literal identifiers like `PATH` and `HEAD`.
- **plugins/output-styles**: gave the comma rule a lawful form for enumerations (a noun list sharing one predicate is one fact) and gave `├─`/`└─` an applicability test (3+ links, genuine causation).

## v0.0.56 - 2026-07-31

### Changes
- **plugins/lean-agents**: any agent carrying the `Agent` tool now also carries `SendMessage`, so it can resume a sub-agent it already spawned instead of spawning a fresh one with no memory of the task. Updated `tools:` frontmatter and roster descriptions on `standard-executor`, `main`, and `full-executor`, plus the shared ladder rosters in the plugin's routing `CLAUDE.md`. `lean-executor` is unaffected — it has neither `Agent` nor `SendMessage`.

## v0.0.55 - 2026-07-29

### Changes
- **plugins/lean-agents**: `Glob`/`Grep` are no longer escalation triggers. `standard-executor` was documented as needing a `full-executor` spawn (~30–40k System-tools tokens) for any search work; since it has Bash, `rg`/`grep` (content) and `find` (path/filename patterns) cover the same ground without adding a tool to its roster. Updated the guidance in `standard-executor`, `full-executor`, `main`, `lean-executor`, and the plugin's routing `CLAUDE.md` so `LSP` (semantic navigation) and `AskUserQuestion` — not search — are what justify moving up the ladder. Also carved search out of the "do not improvise with the tools you have" rule, which previously contradicted using shell search. No agent's `tools:` frontmatter changed.
- **plugins/lean-agents**: added output-bounding guidance for shell search. `Grep` caps results at 250 by default; `grep -rn` does not, so the agents that search via Bash are now told to scope to a path, prefer `rg` (gitignore-aware) with `-l`/`-c`, cap with `head`, and exclude `node_modules`/`.git` when using `grep`/`find`. Agents that *do* hold `Glob`/`Grep` are told to prefer them over shelling out. Notes the `Bash(rg:*)`/`Bash(find:*)` permission prerequisite for `lean-executor`, which cannot escalate if a search is denied.
- **plugins/lean-agents**: first tests — `tests/scenarios.md` with 8 routing scenarios evaluated in three passes (bare rosters / OLD v0.0.54 guidance / current guidance), plus `tests/plugins/lean-agents/` index and results. Honest outcome: the suite did **not** reproduce spurious `full-executor` escalation for search, even under the old contradictory text, so this change is a consistency fix plus a search-hygiene improvement rather than a measured token saving. The measured delta is scenario 8 — `standard-executor` now emits bounded, gitignore-aware `rg -n` where the old text led it to an unbounded `grep -rn` at repo root with a temp-file spill. GREEN also caught a real defect in the first draft (`rg --include` is `grep` syntax), now fixed.
- **plugins/project-tasks**: fixed dispatch prompts that told a `lean-executor` (no `Glob`/`Grep`) to search with `Glob`/`Grep`, and a rule that forbade every command except `git log`/`Glob`/`Grep`/`Read`. Now specifies bounded `rg`/`find` while keeping the read-only constraint intact.

## v0.0.54 - 2026-07-22

### Changes
- **plugins/lean-agents**: new plugin. Houses the four reduced-toolset sub-agent profiles — `lean-executor` (6 tools: Bash, Edit, EnterWorktree, ExitWorktree, Read, Write), `standard-executor` (8 tools, includes Skill + Agent for self-escalation), `main` (12 tools, interactive profile with Glob/Grep/LSP/AskUserQuestion), and `full-executor` (31 tools, no MCP). Plus a plugin-scoped `CLAUDE.md` documenting the five-tier escalation ladder (lean → standard → main → full → general-purpose) and routing rules. Each agent's `description:` field embeds its tool roster for parent-agent comparison. Moved from `plugins/project-tasks/agents/` so the agents can evolve independently of the consumer skill.
- **plugins/project-tasks**: trimmed. The `agents/` directory was removed (all four agent files migrated to the new `lean-agents` plugin). The skill still dispatches to `lean-executor` and `general-purpose` by name — `lean-agents` must be enabled alongside `project-tasks` for those dispatches to resolve.

## v0.0.53 - 2026-07-10

### Changes
- **plugins/output-styles**: rewrote the "Terse" output style for clarity — each rule now stated exactly once (label-block spec was defined three times), resolved the conflicting 2+/two-bullet trigger rules in favor of a hard trigger at 2+ items, merged the overlapping plan-mode sections, consolidated the scattered filler bans and snippet exceptions, and cut dead meta-commentary. No rules lost; body reorganized from 14 sections into 7.

## v0.0.52 - 2026-07-02

### Changes
- **packages/git-utils**: `repos` now shows every repo currently in flight (not just one) to the right of the Phase 1 fetch progress bar, alphabetically listed and capped at 6 names with a "+K more" suffix beyond that — since fetches run in parallel, a single "first incomplete repo" display could get stuck on a slow repo while the bar advanced from others finishing.

## v0.0.51 - 2026-07-02

### Changes
- **packages/git-utils**: fixed `repos` not exiting on Ctrl-C (SIGINT) or SIGTERM — the previous combined `EXIT INT TERM` trap never called `exit`, so the script would resume execution after cleaning up backgrounded jobs instead of terminating. It now uses a `cleanup()` function plus explicit `INT`/`TERM` traps that exit (130/143) after cleanup.

## v0.0.50 - 2026-07-01

### Changes
- **packages/git-utils**: `repos` no longer hangs on interactive git/gh credential, SSH host-key, or passphrase prompts — prompts are disabled, subprocess stdin is redirected, network calls are wrapped with a timeout where available, and the whole process group is killed on exit/interrupt.

## v0.0.49 - 2026-06-28

### Changes
- **packages/git-utils**: added a package README documenting the `repos` script's usage, `--sync` flag, requirements, and configuration; linked from the top-level README.
- **packages/claude-optin**: added MCP server management. The TUI now has two tabs — Plugins and MCP Servers — switched with `Tab`, sharing the same keybindings and three-state (inherit → on → off) toggling. Servers are discovered from every `.mcp.json` found walking the current directory up to `$HOME`, plus user-scope servers in `~/.claude.json`; toggling moves a name between `enabledMcpjsonServers` / `disabledMcpjsonServers` so a disabled server stays defined but loads no context. Names listed in settings with no matching definition are shown flagged as orphans. The `D` (delete) hint now shows only on the Plugins tab, since delete is plugin-only. Added a `test_claude_optin.py` unit suite covering discovery and settings logic.

## v0.0.48 - 2026-06-25

### Changes
- **packages/claude-optin**: added README documenting the token-reduction purpose, installation, keybindings, and how to enable/disable plugins at the user and project level.

## v0.0.47 - 2026-06-23

### Changes
- **packages/git-utils**: added `repos` script — workspace-level git status, branch sync, local changes, and open PRs for every repo in a directory, with interactive pull/push offers.

## v0.0.46 - 2026-06-23

### Changes
- **plugins**: removed `version` field from all `plugin.json` files. Claude Code now uses the git commit SHA for update detection, so every commit auto-delivers to marketplace subscribers.

## v0.0.45 - 2026-06-23

### Changes
- **CLAUDE.md**: clarified that `npm run install-packages` is only needed for `packages/` changes; `plugins/` are installed via marketplace and take effect automatically.

## v0.0.44 - 2026-06-23

### Changes
- **skills**: added `disable-model-invocation: true` to 5 advisory/reference skills (`agent-team-development`, `orchestration-strategy`, `rust-coding`, `textual-api-reference`, `textual-css-reference`) to prevent auto-triggering on description match and reduce unnecessary token usage. All 5 remain explicitly invocable by name.

## v0.0.43 - 2026-06-22

### Changes
- **project-tasks**: the SQLite helper now ships inside the plugin at `bin/task-db` instead of being copied to `~/.claude/task-db.mjs` by the TUI installer (the plugin `manifest.json` that drove that copy was removed; it no longer appears in `install-packages`). SKILL.md resolves the helper once into `$TASK_DB`: on Claude Code the plugin's `bin/` is on the Bash tool's `PATH`, so it uses the bare `task-db` command; on other hosts (e.g. Codex) or TUI-installer setups it falls back to `node <path>/bin/task-db`, with the legacy `~/.claude/task-db.mjs` as a last resort. The DB location is configurable via `PROJECT_TASKS_HOME`/`CODEX_HOME` (defaults to `~/.claude`), and a `.codex-plugin/plugin.json` makes the plugin installable under Codex. Supersedes the `feat/codex-support` branch's approach.

## v0.0.42 - 2026-06-22

### Changes
- **installer**: `files`-type packages now support an optional `destDir` field in `manifest.json` (with `~` expansion, defaulting to `~/.claude/`). Discovery, install, and remove all honor it.
- **claude-optin**: now installs to `~/.local/bin/` instead of `~/.claude/`, so it can be run as a bare `claude-optin` command when `~/.local/bin` is on `PATH`. Manifest example, README, and install destination updated.

## v0.0.41 - 2026-06-13

### Fixes
- **textual-api-reference**: add explicit import module notes for `ContentSwitcher` (`from textual.widgets`, NOT `textual.containers`) and `MarkdownViewer` — live Step 9 test caught an ImportError from the wrong module
- **tests/textual**: record Steps 8–10 progressive test results; Step 8 caught `Select.BLANK` hallucination (GREEN correctly used `Select.NULL`); Step 9 caught wrong ContentSwitcher import; Step 10 was a TIE (both approaches correct)

## v0.0.40 - 2026-06-13

### Features
- **tests/textual**: add `run_textual_test.py` — headless Textual CSS test runner using `run_test()` harness; exits 0 on clean CSS, exits 1 with exact property errors and line numbers
- **tests/textual**: add `test-textual-app-progressive.md` — 10-step progressive test suite building a real Textual chat app; validates both CSS correctness (via runner) and widget API usage (via Haiku judge); replaces knowledge-retrieval prompts with task-based coding prompts that simulate actual agent usage

## v0.0.39 - 2026-06-13

### Fixes
- **tests/textual**: record first two CSS test runs; fix grid scenario (prompt now covers rows + columns; MUST NOT items now say "recommended as correct" not "appears in response")
- **skill-testing**: add two MUST/MUST NOT authoring rules discovered during live test runs: MUST items must be naturally triggered by the prompt; MUST NOT items must be phrased as "recommended as correct" to avoid false failures when agents correctly call out wrong properties

## v0.0.38 - 2026-06-12

### Features
- **skill-testing**: add Haiku judge agent as the authoritative verification step. After every run (baseline and GREEN) a separate Haiku subagent checks each MUST/MUST NOT item against the response text, quotes evidence, and returns a PASS/FAIL/PARTIAL verdict. Orchestrating agent no longer judges output itself. Adds full judge prompt template and updates Running Tests steps.

## v0.0.37 - 2026-06-12

### Tests
- **textual/test-textual-css-reference**: expand from 4 to 10 scenarios; 6 new tests cover the "adjacent property" and "wrong value" failure modes that cause app crashes: display values, grid-columns vs grid-template-columns, text-style vs font-*, overflow axis requirement, margin: auto invalidity, and Textual-specific border styles.

## v0.0.36 - 2026-06-12

### Tests
- **textual/test-textual-api-reference**: revamp 4 existing scenarios (Button label default, Input Blurred message) and add 4 new ones covering Select sentinel/message fabrication, ContentSwitcher message fabrication, Footer reactive attrs, and Toast creation pattern.

## v0.0.35 - 2026-06-12

### Fixes
- **textual/textual-api-reference**: validated all 37 widgets against official docs; removed 5 fabricated messages/attributes, corrected 10 wrong defaults, fixed 6 wrong APIs, added ListItem (missing widget), Footer reactive attrs, shared attributes section, and ToggleButton base documentation.

## v0.0.34 - 2026-06-12

### Features
- **tests**: add `tests/` directory infrastructure mirroring `plugins/` and `packages/` layout, with `README.md`, `index.md`, and `test-results.md` in each subdirectory. Textual plugin gets `test-textual-css-reference.md` and `test-textual-api-reference.md` with MUST/MUST NOT acceptance criteria.
- **skill-testing**: new package with `SKILL.md` documenting the full skill-testing process — directory structure, scenario file format, baseline (RED) + GREEN test runs, and PASS/FAIL/PARTIAL evaluation criteria.

## v0.0.33 - 2026-06-12

### Features
- **textual**: new plugin with two reference skills — `textual-css-reference` (valid CSS properties, types, invalid properties, and common mistakes) and `textual-api-reference` (complete built-in widget reference covering all widgets with reactive attributes, constructor parameters, and messages emitted). Registered in marketplace.json.

## v0.0.32 - 2026-06-07

### Features
- **project-tasks**: replace the single-line `git remote || basename` project lookup with a 3-tier mechanism — Tier 1 walks up from cwd to the git toplevel (or `/` when not in a git repo) looking for `.claude/project-tasks.json`; Tier 2 falls back to a normalized git remote URL (matches `normalizeProject()` in `task-db.mjs`, so SSH/HTTPS/with-or-without-`.git` collapse to the same key); Tier 3 falls back to the git toplevel basename in git repos only. When all three tiers return empty, the skill now prompts the user to provide a name and offers to create `.claude/project-tasks.json` — preventing the silent directory-basename fallback that fragmented task lists across agents and worktrees. Project reads trim whitespace and tolerate malformed JSON; project writes use `JSON.stringify` so quoted/escaped names round-trip correctly. README updated.
- **project-tasks**: new test `test-project-discovery.md` covers all four scenarios (file at project root, file at project root with nested cwd, no file with git remote, no file and no git).

## v0.0.31 - 2026-06-04

### Features
- **task-db**: canonicalize project name at the SQL boundary via `normalizeProject()`, so all URL forms (SSH/HTTPS, with/without `.git`, with/without trailing slash) collapse to the same `host/owner/repo` key. Future inserts/queries automatically land in the right list.
- **task-db**: new `migrate` subcommand rebuilds the `project` column for existing fragmented data. SELECT DISTINCT project → run each through the normalizer → build a (old → new) map → renumber `seq` per source to `MAX(target.seq)+1` (so the `UNIQUE(project, seq)` constraint can't trip on overlapping seqs) → bulk-update `project`. Idempotent; a second run is a no-op.

## v0.0.30 - 2026-06-04

### Fixes
- **Statusline**: fix root cause of `(0/200K)` display — Claude Code 2.x moved token counts into `context_window.current_usage` and added `total_input_tokens` as the authoritative sum; `totalContextTokens` now reads these correctly instead of looking for flat top-level fields that no longer exist

## v0.0.29 - 2026-06-04

### Fixes
- **Statusline**: fix `(0/200K)` display when Claude Code sends only `used_percentage` (not `input_tokens`/`cache_*` fields) — now derives approximate token count as `round(pct * windowSize / 100)`; also restores time-to-fill ETA which was silently suppressed in the same scenario

## v0.0.28 - 2026-06-04

### Fixes
- **Statusline**: clamp displayed percentage to 100 when tokens exceed the effective window size (an over-100% value was printed as raw text alongside a maxed bar)
- **Statusline**: unify bar and ETA numerators via `totalContextTokens()` — both now use `input_tokens + cache_creation + cache_read` so they agree on "used"
- **Statusline**: normalize model display names for override lookup by stripping `"Claude "` prefix and `"(NM context)"` suffixes, preventing silent override loss on Anthropic version renames
- **Statusline**: add `existsSync` short-circuit to config loader (avoids wasted syscall + exception per render when config is absent); distinguish parse errors from missing-file and warn on malformed JSON
- **Statusline**: harden all e2e config-writing tests with `try/finally` cleanup so a failed assertion never leaves a stale `statusline-config.json` in the source tree
- **Statusline**: ship `statusline-config.json` example config; installer seeds it to `~/.claude/`; update README for `sections` whitelist (replaces the old `disabledSections` blacklist)
- **Statusline**: add regression tests for clamping, ETA/bar consistency, and normalized model name matching; fix pre-existing test bugs (progressBar space char, shortenPath single-segment preservation, branch prefix stripping, PCT glyph vs ASCII %, used/max format)

## v0.0.27 - 2026-06-03

### Features
- Statusline now supports per-model context-window size overrides via `~/.claude/statusline-config.json`. Configure custom window sizes with a `modelContextWindows` map (e.g. `{"Claude Sonnet 4.6": 200000}`). The percentage calculation is now token-based, accounting for cache tokens: `round((input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / context_window_size * 100)`, with fallback to `used_percentage` for backward compatibility. New functions `resolveContextWindowSize` and `computeUsedPct` are exported and tested. Adds 18 new tests (7 + 10 unit + 1 E2E).

## v0.0.26 - 2026-06-03

### Features
- Statusline context segment now appends the absolute context-window maximum in parentheses after the progress bar, e.g. `80% ████░░░░ (200K)` or `80% ████░░░░ (1M)`. Lets you see at a glance which model class is active. Renders via new `formatTokenCount` helper; gracefully omitted when `context_window_size` is absent (early-session case). Adds 10 tests (7 unit + 3 E2E).

## v0.0.25 - 2026-06-03

### Fixes
- Extend `task-db` `update` command to support all task fields: `--type`, `--title`, `--created`, `--completed-at`, `--feedback`, and repeatable `--tag`, `--req`, `--dep` flags. Adds `feedback` and `completed_at` columns via migration in the `init` command.

## v0.0.24 - 2026-05-20

### Features
- Add `output-styles` package shipping a new `Concise` style — terse one-or-two-sentence answers and action lists routed into TaskCreate calls. Install with `npm run install-package output-styles` and select via Claude Code's `/output-style` picker.

### Fixes
- Installer (`installFiles`) now creates parent directories before copying, enabling `files`-type packages to ship files into nested paths like `output-styles/<name>.md`.

## v0.0.23 - 2026-04-30

### Tasks
- Add two-entry TaskList approach: Scout and Execute as separate TaskList entries
- Add 2-stage pipeline test document with full state transition coverage (pending → scouting → executing → completed)
- Add comment to test-run-task.md noting it covers pre-2-stage single-agent dispatch
- Add test task demonstrating 2-stage pipeline execution with persistent task list

## v0.0.22 - 2026-03-30

### Fixes
- Remove dead `depends_on` column migration from task-db init that caused "duplicate column name" error on existing databases
- Remove one-off `migrate-tasks.ts` script and associated npm scripts — markdown-to-SQLite migration is complete

## v0.0.21.1 - 2026-03-21

### Features
- Installer now compares SHA-256 hashes of source vs installed files to detect outdated packages
- Files packages show `(current)` when hashes match, `(upgrade)` when outdated, `(installed)` for symlinked items
- Cards show yellow "UPGRADE" badge when updates are available
- Results view distinguishes "Updated" from "Copied" for reinstalled files

### Fixes
- Fix task-db.mjs "duplicate column name: depends_on" error by removing unnecessary ALTER TABLE migration
- Add "never delete tasks.db" rule to project-tasks skill to prevent data loss

## v0.0.21 - 2026-03-18

### Features
- Add `log task:` and `log fix:` prefix shortcuts to project-tasks skill — always saves as Log Only without presenting the execution prompt
- Add `run task:` and `run fix:` prefix shortcuts — logs the task and immediately runs it through the full execution pipeline (Check Dependencies → Isolation → Scout + Executor)

## v0.0.20 - 2026-03-15

### Features
- Upgrade project-tasks skill to 2-stage execution pipeline: Sonnet scout (read-only) produces Implementation Map with ownership analysis, then Haiku executor follows it mechanically
- Add ownership analysis step to scout prompt — guides models to place state on data-owning classes and logic in shared modules, improving cross-file architectural judgment by ~29%
- Fix invalid `subagent_type: "haiku"` in check-task section (now uses `subagent_type: "general-purpose"` with `model: "haiku"`)

## v0.0.19 - 2026-03-13

### Features
- Add Claude Code plugin marketplace — skills are now installable via `/plugin marketplace add cjthompson/claude-code-config`
- Restructure skills from `packages/skills/` to `plugins/<name>/` following the Claude Code plugin format
- Each skill is a standalone plugin with `.claude-plugin/plugin.json` and marketplace index at `.claude-plugin/marketplace.json`
- Update TUI installer to discover skills from `plugins/` directory

## v0.0.18 - 2026-03-13

### Tasks
- Add `task-db.mjs` helper script package — wraps all SQLite operations in a simple CLI, replacing raw sqlite3 calls in the project-tasks skill and reducing bash permissions to a single `Bash(node ~/.claude/task-db.mjs *)` entry

## v0.0.17 - 2026-03-13

### Fixes
- Switch project-tasks INSERT statements to quoted heredoc to fix sqlite3 escaping errors when values contain single quotes; update permission tip to include `Bash(P=*)`

## v0.0.16 - 2026-03-13

### Tasks
- Add first-time setup tip to project-tasks skill suggesting `Bash(sqlite3 *)` permission in `~/.claude/settings.json` to avoid sqlite3 approval prompts

## v0.0.15 - 2026-03-10

### Tasks
- Add `depends_on` support to project-tasks skill — tasks can declare dependencies on other tasks, blocked tasks shown in listings, dispatch prevented until deps complete

## v0.0.14 - 2026-03-10

### Tasks
- Add one-off migration script (`npm run migrate-tasks`) to migrate existing docs/TASKS.md files into the global SQLite database

## v0.0.13 - 2026-03-10

### Tasks
- Migrate project-tasks storage from markdown (docs/TASKS.md) to SQLite (~/.claude/tasks.db) for reduced token usage — tasks scoped per-project, queried via sqlite3 CLI, with in_changelog tracking column

## v0.0.12 - 2026-03-10

### Tasks
- Skill defers git commit until user selects Accept

## v0.0.10 - 2026-03-10

### Tasks
- Defer git commit to Accept step in project-tasks skill — subagent no longer commits; lead agent commits after user accepts

## v0.0.9 - 2026-03-10

### Features
- Add `install-package` non-interactive CLI (`npm run install-package <name> [<name>...]`) to install specific packages or skills by name without launching the TUI. Names are matched case-insensitively against package IDs, labels, and individual item names. Exits non-zero if any name is not found or any install fails.

## v0.0.8 - 2026-03-10

### Features
- Add `reinstall` npm script (`npm run reinstall`) that non-interactively detects already-installed packages and reinstalls them, using the same discovery and install logic as the main installer

## v0.0.7 - 2026-03-09

### Docs
- Add "Repository-Based Changes" section to CLAUDE.md clarifying how to make changes to repo-contained items (skills, configs) and how to apply them using `npm run install-packages`

## v0.0.5 - 2026-03-09

### Tasks
- Change `todo:` prefix to always Log Only — skip execution choice prompt and save as pending with no dispatch

## 2026-03-09

### Features
- Add custom skills: agent-team-development, orchestration-strategy, project-tasks, rust-coding
- Add skill install script

### Docs
- Add skills section to README

## 2026-02-28

### Tasks
- Improve display with wrapping and powerline symbols

## 2026-02-27

### Tasks
- Dynamically adjust sections based on terminal width

## 2026-02-25

### Tasks
- Add statusline script
- Initial commit
