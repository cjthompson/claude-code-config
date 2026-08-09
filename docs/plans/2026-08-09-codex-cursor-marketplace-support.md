# Codex and Cursor Marketplace Support Implementation Plan

> Status: proposed; implementation has not started.
>
> Recovered scope decisions: port every repository plugin, provide functional
> host adaptations rather than manifest-only listings, and coordinate the
> repository-wide work with the existing Python plugin migration.

**Goal:** Make all ten plugins in this repository installable from complete
repository-local Codex and Cursor marketplaces, with working native or
explicitly adapted behavior on each host and a tested, honest compatibility
matrix.

**Architecture:** Keep each existing `plugins/<name>/` directory as the unit of
distribution. Reuse host-neutral skills and scripts directly. Add thin
host-specific adapters only where the hosts expose different primitives:
Cursor-native agents and hooks, Codex skills for behavior that Codex's current
validated plugin schema cannot declare as an agent or hook, and capability-based
orchestration instructions where tool names differ. Treat
`.claude-plugin/marketplace.json` as the complete plugin inventory, then enforce
set equality against the Codex and Cursor marketplaces with repository tests.
Do not generate one host's manifest from another because the schemas and
capability metadata are materially different.

**Implementation skills:** Use `plugin-creator` for Codex manifests and
marketplace contracts, `python-development:python-testing` for the structural
and hook-adapter tests, `python-development:dignified-python` when refactoring
the watchdog scripts, `superpowers:test-driven-development` for each behavior
port, and `superpowers:verification-before-completion` before claiming the
migration is ready.

**Primary references:**

- [OpenAI Plugins](https://developers.openai.com/plugins)
- [Cursor Plugins](https://cursor.com/docs/plugins)
- [Cursor Plugins Reference](https://cursor.com/docs/reference/plugins)
- [Cursor Hooks Reference](https://cursor.com/docs/hooks)

## Scope and stop conditions

### In scope

- All ten plugins currently listed in `.claude-plugin/marketplace.json`:
  `project-tasks`, `lean-agents`, `output-styles`,
  `orchestration-strategy`, `agent-team-development`, `rust-coding`,
  `textual`, `command-watchdog`, `python-scripting`, and
  `python-development`.
- A complete repository Codex marketplace at
  `.agents/plugins/marketplace.json`.
- A complete Cursor multi-plugin marketplace at
  `.cursor-plugin/marketplace.json`.
- A valid `.codex-plugin/plugin.json` and `.cursor-plugin/plugin.json` for
  every plugin.
- Functional adaptations for skills, orchestration, agent profiles, output
  styles, hooks, helper discovery, and model-selection differences.
- Automated repository validation and manual host acceptance checklists.
- Documentation for local/repository installation and Cursor public-submission
  readiness.

### Out of scope

- Submitting the repository to Cursor's public marketplace. Cursor requires a
  public repository and manual review; submission is an external action to take
  only after the implementation is accepted and merged.
- Creating ten logos. Cursor recommends logos but does not require them. Treat a
  coordinated visual identity as a separate design task.
- Adding new plugin features unrelated to host compatibility.
- Replacing the existing Claude marketplace or TUI installer.
- Reading or modifying installed files under `~/.codex`.
- Committing, merging, installing, publishing, or changing task state without
  explicit user authorization.

### Working-tree dependency

The checkout was dirty when this plan was written. It contains staged,
unstaged, and untracked Python-plugin work governed by
`docs/plans/2026-08-09-python-scripting-and-development-plugins.md`.
Implementation of this plan must begin only after that work has an explicit
accepted baseline, or in a user-approved isolated worktree created from a commit
that contains the intended Python plugin state. Do not copy, discard, or
silently absorb the current dirty changes.

## Design decision

Use shared source plus host adapters.

- **Chosen:** Retain one plugin directory and one canonical implementation of
  shared behavior. Add a host adapter only for a schema or runtime difference.
  Tests enforce parity without pretending the manifests are interchangeable.
- **Rejected:** Manifest-only support. It would list plugins that do not work on
  the target host and conflicts with the recovered functional-port decision.
- **Rejected:** Three complete copies of every plugin. It would make behavior,
  security fixes, and documentation drift independently across hosts.
- **Rejected:** Generate every marketplace and manifest from one universal
  schema. Codex and Cursor have different component models and metadata; a
  generator would become a second plugin platform before it reduces meaningful
  maintenance.

## Compatibility contract

Use these labels in documentation and tests:

- **Native:** The host directly supports the existing component type.
- **Adapted:** The user-visible outcome is provided through a supported host
  primitive, but activation or enforcement differs.
- **Unavailable:** No safe functional equivalent exists. This plan has no
  intended `Unavailable` entries; if implementation discovers one, stop and
  revise the plan rather than shipping a misleading marketplace entry.

| Plugin | Existing payload | Codex target | Cursor target |
|---|---|---|---|
| `project-tasks` | Skill plus `bin/task-db` | Native skill; retain Codex data-root and Terra/Luna paths | Native skill; add Cursor helper discovery, data root, default-model fallback, and manifest |
| `lean-agents` | Four Claude custom agents plus routing rules | Adapted routing skill that uses available Codex agent types and tool capabilities | Native Cursor custom-agent files with Cursor-valid frontmatter plus shared routing guidance |
| `output-styles` | Two Claude output-style files | Adapted explicitly invoked skills for concise and terse responses | Adapted skills users can set to Agent Decides or Manual in Customize |
| `orchestration-strategy` | Claude-oriented orchestration skill | Native capability-based skill with Codex collaboration paths | Native capability-based skill with Cursor subagent paths |
| `agent-team-development` | Claude TeamCreate workflow | Native when Codex collaboration communication is available; leader-mediated fallback otherwise | Native Cursor subagents with leader-mediated coordination; do not claim peer-team communication |
| `rust-coding` | Skill | Native shared skill | Native shared skill |
| `textual` | Two reference skills | Native shared skills | Native shared skills |
| `command-watchdog` | Claude `PreToolUse` hook and Python watchdog | Adapted skill that explicitly wraps matching shell commands because validated Codex manifests cannot declare hooks | Native `preToolUse` hook adapter that returns Cursor's `updated_input` response |
| `python-scripting` | Four skills and LSP config | Preserve existing native skill plugin; CLI quality checks do not depend on LSP | Preserve existing native skills; verify whether Cursor loads `.lsp.json`, otherwise document it as Claude-only |
| `python-development` | Six skills and vendored references | Preserve existing native skill plugin | Preserve existing native skill plugin |

### Host-specific invariants

1. The three root marketplaces contain exactly the same ten plugin names.
2. Codex and Cursor manifests use strict semantic versions even though Claude
   manifests intentionally may omit them.
3. All marketplace sources are relative, stay within the repository, and point
   to a plugin directory containing the matching host manifest.
4. Shared skill content talks about capabilities first. Host tool names appear
   only in clearly labeled host branches.
5. No Codex manifest declares unsupported `agents`, `commands`, `rules`, or
   `hooks` fields. Adapted Codex behavior is exposed through `skills`.
6. The five existing Claude-manual advisory skills become cross-host Agent
   Skills under `skills/` and omit `disable-model-invocation: true`, because the
   current Codex contract requires model-invocable skills at that exact path.
   Their descriptions must remain narrow, and the Claude activation change
   must be documented and behaviorally tested.
7. Cursor manifests explicitly select host-specific component paths when a
   default directory contains Claude-format files. This prevents Cursor from
   accidentally discovering incompatible `agents/` or `hooks/hooks.json`
   content.
8. Cursor per-plugin manifests use the currently documented manifest fields;
   discovery metadata such as category stays in the marketplace entry unless
   Cursor's live validator documents it for `plugin.json`.
9. Claude behavior remains regression-tested while adding the two new hosts.
10. A plugin cannot be added to a root marketplace until its functional port and
   per-plugin manifest pass their targeted tests.

## Task 0: Establish an implementation baseline

**Files:** none unless the user first accepts the current Python changes.

- [ ] Record `git status --short --branch`, `git log -5 --oneline`, and the
      exact commit intended as the implementation base.
- [ ] Resolve the current staged/unstaged Python work under its existing plan.
- [ ] With user approval, create an isolated feature worktree from the accepted
      base. Do not execute this plan directly in a dirty `main` checkout.
- [ ] Re-read the live `AGENTS.md` and confirm the no-install/no-commit boundary
      for the implementation session.
- [ ] Run the existing baseline checks before changing marketplace files:

```bash
npm run typecheck
python3 tests/plugins/python/test_python_plugins.py -v
node plugins/python-development/scripts/sync-typing-references.mjs --check
git diff --check
```

Expected: all checks pass on the accepted baseline. If they do not, record the
pre-existing failure and stop rather than folding it into this migration.

## Task 1: Add the repository-wide marketplace contract tests

**Files:**

- Create: `tests/plugins/marketplaces/test_marketplaces.py`
- Create: `tests/plugins/marketplaces/test_skill_portability.py`
- Create: `tests/plugins/marketplaces/README.md`

- [ ] Write a failing test with the explicit ten-plugin inventory.
- [ ] Assert exact name-set equality across
      `.claude-plugin/marketplace.json`,
      `.agents/plugins/marketplace.json`, and
      `.cursor-plugin/marketplace.json`.
- [ ] Assert every entry points to `plugins/<name>` and that the matching
      per-host `plugin.json` exists.
- [ ] Validate strict semantic versions and required metadata in Codex and
      Cursor manifests.
- [ ] Validate Codex policy fields:
      `installation: AVAILABLE`, `authentication: ON_INSTALL`, and category.
- [ ] Validate Cursor marketplace fields: kebab-case name, owner, unique plugin
      names, relative sources, and at most 500 entries.
- [ ] Reject undocumented Cursor per-plugin manifest fields unless a live
      Cursor version proves and documents that extension.
- [ ] Validate every declared `skills`, `agents`, `hooks`, `commands`, `rules`,
      or MCP path exists and cannot escape its plugin directory.
- [ ] Reject Codex manifest fields not accepted by the current repository
      contract, including `hooks` and `agents`.
- [ ] Add component-specific expectations for the three adapted plugins so a
      manifest-only implementation cannot turn the suite green.
- [ ] Document how to run the tests and which official schemas they mirror.

Run:

```bash
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
```

Expected before later tasks: failures enumerate the missing Cursor marketplace,
seven missing Codex manifests, eight missing Cursor manifests, and the missing
functional adapters.

## Task 2: Port the directly portable skill plugins

**Files:**

- Modify: `plugins/rust-coding/skills/rust-coding/SKILL.md`
- Create: `plugins/rust-coding/.codex-plugin/plugin.json`
- Create: `plugins/rust-coding/.cursor-plugin/plugin.json`
- Modify: `plugins/textual/skills/textual-api-reference/SKILL.md`
- Modify: `plugins/textual/skills/textual-css-reference/SKILL.md`
- Create: `plugins/textual/.codex-plugin/plugin.json`
- Create: `plugins/textual/.cursor-plugin/plugin.json`
- Modify: `tests/plugins/rust-coding/index.md`
- Modify: `tests/plugins/textual/index.md`

- [ ] Remove `disable-model-invocation: true` from the three Rust/Textual skill
      files so Codex can validate and invoke them. Do not otherwise broaden
      their trigger descriptions.
- [ ] Add regression scenarios proving ordinary Rust/Python work does not load
      these reference skills unless the request actually needs them.
- [ ] Add full Codex metadata, `skills: "./skills/"`, interface metadata,
      capabilities, and three bounded default prompts per plugin.
- [ ] Add only currently documented Cursor manifest metadata and
      `skills: "./skills/"` per plugin.
- [ ] Verify the shared skill frontmatter is accepted by all three hosts.
- [ ] Document that these skills were formerly explicit-only in Claude and now
      rely on narrow trigger descriptions for cross-host compatibility.
- [ ] Add structural assertions for the exact Rust and Textual skill inventory.
- [ ] Re-run the existing Textual headless scenarios after any shared skill
      edit.

Run:

```bash
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
git diff --check
```

Expected: the Rust and Textual manifest/skill checks pass; unrelated missing
ports remain red.

## Task 3: Make orchestration skills capability-based

**Files:**

- Modify: `plugins/orchestration-strategy/skills/orchestration-strategy/SKILL.md`
- Modify: `plugins/agent-team-development/skills/agent-team-development/SKILL.md`
- Create: `plugins/orchestration-strategy/.codex-plugin/plugin.json`
- Create: `plugins/orchestration-strategy/.cursor-plugin/plugin.json`
- Create: `plugins/agent-team-development/.codex-plugin/plugin.json`
- Create: `plugins/agent-team-development/.cursor-plugin/plugin.json`
- Modify: `plugins/orchestration-strategy/skills/orchestration-strategy/tests/scenarios.md`
- Modify: `plugins/agent-team-development/skills/agent-team-development/tests/scenarios.md`
- Modify: `tests/plugins/orchestration-strategy/index.md`
- Modify: `tests/plugins/agent-team-development/index.md`
- Modify: `tests/plugins/marketplaces/test_skill_portability.py`

- [ ] Remove `disable-model-invocation: true` from both skills, keep their
      trigger descriptions narrowly scoped, and add negative scenarios proving
      they do not activate for ordinary one-task work.
- [ ] Add a host-capability preflight that distinguishes solo work, independent
      parallel subagents, sequential subagents, and communicating teams.
- [ ] Preserve Claude's TeamCreate workflow when those tools are present.
- [ ] Add a Codex branch using the available collaboration spawn, message,
      follow-up, interrupt, and wait capabilities without hard-coding tool calls
      when the runtime does not expose them.
- [ ] Add a Cursor branch using Cursor subagents and leader-mediated result
      integration. State plainly that Cursor subagents are not peer-to-peer
      Agent Teams unless the live host exposes an equivalent capability.
- [ ] Replace unconditional Claude tool-name prerequisites with capability
      checks and explicit fallbacks.
- [ ] Preserve worktree isolation, ownership boundaries, integration-before-
      shutdown, and user acceptance gates on every host.
- [ ] Add scenarios for Claude-native teams, Codex communicating agents, Cursor
      leader-mediated subagents, missing subagent tools, and unsafe file overlap.
- [ ] Run GREEN exercises on each available host; do not fabricate results for
      a host that was not run.

Run:

```bash
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
rg -n 'TeamCreate|SendMessage|spawn_agent|subagent|Cursor' \
  plugins/orchestration-strategy plugins/agent-team-development
git diff --check
```

Expected: tool names occur only in labeled host branches, and the shared
decision rules have a safe path on all three hosts.

## Task 4: Port lean agent profiles without claiming unsupported enforcement

**Files:**

- Create: `plugins/lean-agents/skills/lean-agent-routing/SKILL.md`
- Create: `plugins/lean-agents/cursor-agents/lean-executor.md`
- Create: `plugins/lean-agents/cursor-agents/standard-executor.md`
- Create: `plugins/lean-agents/cursor-agents/main.md`
- Create: `plugins/lean-agents/cursor-agents/full-executor.md`
- Create: `plugins/lean-agents/.codex-plugin/plugin.json`
- Create: `plugins/lean-agents/.cursor-plugin/plugin.json`
- Modify: `plugins/lean-agents/tests/scenarios.md`
- Modify: `tests/plugins/lean-agents/index.md`
- Modify: `tests/plugins/marketplaces/test_marketplaces.py`
- Modify: `tests/plugins/marketplaces/test_skill_portability.py`

- [ ] Keep `plugins/lean-agents/agents/*.md` and `CLAUDE.md` as the Claude
      implementation; do not make Cursor discover those files by default.
- [ ] Define four Cursor custom agents under `cursor-agents/` using only
      Cursor-supported `name` and `description` frontmatter plus behavioral
      instructions appropriate to Cursor's tool surface.
- [ ] Point the Cursor manifest explicitly at `./cursor-agents/` and
      `./skills/`.
- [ ] Add a Codex routing skill that selects the cheapest available agent type
      by task capability, gives it a bounded prompt, and escalates only when a
      tool gap is real.
- [ ] Reuse a built-in Codex `lean-executor` type when available, but do not
      claim that installing this plugin creates or enforces new Codex agent
      tool rosters.
- [ ] State the Cursor limitation: prompt-defined behavior is native, but a
      reduced prompt does not prove reduced system-tool token overhead unless
      Cursor exposes tool-whitelist enforcement.
- [ ] Add tests that reject Claude-only frontmatter in `cursor-agents/`, verify
      all four names, and require the Codex routing skill.
- [ ] Extend scenarios for text search, semantic search, clarification,
      worktree needs, unavailable tools, and escalation on both adapted hosts.

Run:

```bash
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
rg -n '^name:|^description:|^tools:|^model:' plugins/lean-agents/cursor-agents
git diff --check
```

Expected: Cursor gets four valid custom agents; Codex gets a functional routing
skill; neither manifest promises unsupported tool-roster enforcement.

## Task 5: Port output styles as explicit host skills

**Files:**

- Create: `plugins/output-styles/skills/concise-output/SKILL.md`
- Create: `plugins/output-styles/skills/terse-output/SKILL.md`
- Create: `plugins/output-styles/.codex-plugin/plugin.json`
- Create: `plugins/output-styles/.cursor-plugin/plugin.json`
- Create: `tests/plugins/output-styles/test_output_style_ports.py`
- Modify: `tests/packages/output-styles/index.md`
- Modify: `tests/plugins/marketplaces/test_marketplaces.py`

- [ ] Preserve the two Claude files in `output-styles/` for `/output-style`.
- [ ] Create explicitly invoked skills that reproduce the concise and terse
      user-visible response contracts using host-neutral capability language.
- [ ] Translate Claude-only `TaskCreate`, `AskUserQuestion`, and plan-mode
      wording to capability checks or host-neutral instructions.
- [ ] Point both new host manifests at `./skills/`.
- [ ] Document that activation differs: Claude uses `/output-style`, while
      Codex invokes a skill and Cursor exposes the skill under Customize as
      Agent Decides or Manual.
- [ ] Add tests for answer-first behavior, brevity exceptions, identifier/path
      precision, action-list handling, and the required terminal result block.
- [ ] Add parity assertions for the shared behavioral invariants while allowing
      host-specific activation wording.

Run:

```bash
python3 tests/plugins/output-styles/test_output_style_ports.py -v
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
git diff --check
```

Expected: both output modes are functionally invocable on Codex and Cursor
without being mislabeled as native host-wide output-style settings.

## Task 6: Split watchdog core logic from host hook protocols

**Files:**

- Preserve: `plugins/command-watchdog/hooks/command-watchdog.py`
- Create: `plugins/command-watchdog/hooks/watchdog_common.py`
- Modify: `plugins/command-watchdog/hooks/bash-watchdog.py`
- Create: `plugins/command-watchdog/hooks/cursor-watchdog.py`
- Create: `plugins/command-watchdog/hooks/cursor-hooks.json`
- Create: `plugins/command-watchdog/skills/command-watchdog/SKILL.md`
- Create: `plugins/command-watchdog/.codex-plugin/plugin.json`
- Create: `plugins/command-watchdog/.cursor-plugin/plugin.json`
- Create: `tests/plugins/command-watchdog/test_watchdog_common.py`
- Create: `tests/plugins/command-watchdog/test_claude_hook.py`
- Create: `tests/plugins/command-watchdog/test_cursor_hook.py`
- Create: `tests/plugins/command-watchdog/test_watchdog_process.py`
- Modify: `tests/plugins/marketplaces/test_marketplaces.py`

- [ ] First capture the existing pattern parsing, environment-prefix stripping,
      pass-through, RTK fallback, command wrapping, and fail-open behavior in
      tests.
- [ ] Extract only host-independent parsing and wrapping logic into
      `watchdog_common.py`; preserve `command-watchdog.py` as the process-group
      monitor.
- [ ] Keep `bash-watchdog.py` as the Claude protocol adapter and verify its
      `hookSpecificOutput.updatedInput.command` response.
- [ ] Implement `cursor-watchdog.py` as a Cursor `preToolUse` adapter. Accept
      Cursor's `Shell` input and return direct `permission: allow` plus
      `updated_input.command` when a pattern matches.
- [ ] Use `cursor-hooks.json` rather than Cursor's default discovery of the
      Claude-format `hooks/hooks.json`; point the Cursor manifest explicitly at
      the Cursor config.
- [ ] Verify the plugin hook working directory and script path in a real local
      Cursor load. If relative plugin paths are not stable, use the documented
      plugin-root mechanism; do not guess an environment variable.
- [ ] Create a host-neutral watchdog skill under `./skills/` and point the Codex
      manifest at that required path. The skill must load
      `watchdog-patterns.txt`, detect a matching shell command before execution,
      and explicitly run it through `command-watchdog.py`. Cursor may expose
      the same skill alongside its native hook, but the hook remains the default
      automatic path.
- [ ] Document the Codex limitation: this protects commands issued while the
      skill is active but cannot interpose on every shell call as a native hook.
- [ ] Test matched and unmatched commands, environment prefixes, malformed
      patterns, recursive wrapping prevention, RTK present/absent, CPU progress,
      output progress, idle termination, exit-code propagation, and fail-open
      adapter errors.
- [ ] Preserve and document the watchdog's supported operating-system boundary.
      Do not advertise Windows support while the process-group and diagnostics
      implementation remains POSIX/macOS-oriented.

Run:

```bash
python3 -m unittest discover -s tests/plugins/command-watchdog -p 'test_*.py' -v
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
git diff --check
```

Expected: Claude hook behavior is unchanged, Cursor rewrites matching Shell
commands through its native hook protocol, and Codex has an honest explicit
wrapper workflow.

## Task 7: Complete project-tasks support for Cursor without regressing Codex

**Files:**

- Modify: `plugins/project-tasks/skills/project-tasks/SKILL.md`
- Create: `plugins/project-tasks/cursor-skills/project-tasks/SKILL.md`
- Create: `plugins/project-tasks/.cursor-plugin/plugin.json`
- Modify: `plugins/project-tasks/skills/project-tasks/tests/test-project-discovery.md`
- Modify: `plugins/project-tasks/skills/project-tasks/tests/test-run-task.md`
- Modify: `plugins/project-tasks/skills/project-tasks/tests/test-2stage-pipeline.md`
- Modify: `tests/plugins/project-tasks/index.md`
- Create: `tests/plugins/project-tasks/test_host_compatibility.py`
- Modify: `tests/plugins/marketplaces/test_skill_portability.py`

- [ ] Extend helper discovery to installed Cursor plugin locations without
      weakening the existing bare-`task-db`, repository-relative, Claude, and
      Codex resolution order.
- [ ] Select a Cursor data root under `${CURSOR_HOME:-$HOME/.cursor}` only when
      Cursor is positively identified; continue honoring explicit
      `PROJECT_TASKS_HOME` first.
- [ ] Add `.cursor/project-tasks.json` to project identity discovery while
      retaining `.claude/project-tasks.json` and `.codex/project-tasks.json`.
- [ ] Preserve the user's canonical Codex mapping:
      scout `gpt-5.6-terra`, executor `gpt-5.6-luna`.
- [ ] Keep the existing Claude/Codex skill as the canonical workflow. Add a
      Cursor wrapper with standard `name` and `description` frontmatter that
      loads that workflow, and point the Cursor manifest explicitly at
      `./cursor-skills/` so Cursor does not parse Claude/Codex-only frontmatter.
- [ ] On Cursor, omit explicit model IDs when Cursor cannot accept those Codex
      names; use the current host default and retain the scout/executor role
      separation.
- [ ] Capability-gate background agents, task-list display, model selection,
      worktrees, and interactive review. Database capture/list/update must still
      work when an execution capability is absent.
- [ ] Add tests for Claude, Codex, Cursor, explicit home override, no detectable
      host, missing helper, and missing subagent tools.
- [ ] Update behavioral documentation so examples do not hard-code another
      host's home directory or tool names outside labeled host cases.
- [ ] Because the edited canonical skill contains a `model:` frontmatter field,
      run the repository-required model-subagent exercise and independent Opus
      verification loop after each revision. Continue only after `APPROVED` or
      stop immediately if the user cancels.

Run:

```bash
python3 tests/plugins/project-tasks/test_host_compatibility.py -v
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
rg -n 'gpt-5\.6-terra|gpt-5\.6-luna|Cursor|CODEX_HOME|CURSOR_HOME' \
  plugins/project-tasks/skills/project-tasks/SKILL.md
git diff --check
```

Expected: capture and listing work on all hosts; enhanced execution features
activate only when the current host exposes them; the Codex Terra/Luna contract
remains intact.

## Task 8: Complete both repository marketplaces and all manifests

**Files:**

- Modify: `.agents/plugins/marketplace.json`
- Create: `.cursor-plugin/marketplace.json`
- Verify, and modify only for parity/validation:
  `plugins/python-scripting/.codex-plugin/plugin.json`
- Verify, and modify only for parity/validation:
  `plugins/python-scripting/.cursor-plugin/plugin.json`
- Verify, and modify only for parity/validation:
  `plugins/python-development/.codex-plugin/plugin.json`
- Verify, and modify only for parity/validation:
  `plugins/python-development/.cursor-plugin/plugin.json`
- Modify: `tests/plugins/python/test_python_plugins.py`
- Modify: `tests/plugins/marketplaces/test_marketplaces.py`

- [ ] Add the eight non-Python plugins to the Codex marketplace without
      replacing or reordering the existing Python entries unless a documented
      presentation order is chosen.
- [ ] Give every Codex entry a local relative source, required policy block, and
      `Development` category.
- [ ] Create the root Cursor multi-plugin marketplace with owner, description,
      version, and ten unique entries whose sources resolve to
      `plugins/<name>`.
- [ ] Keep marketplace descriptions, versions, keywords, and category meanings
      aligned with per-plugin manifests while respecting host-specific field
      names.
- [ ] Ensure every per-plugin Codex manifest has strict semver, author,
      description, license, keywords, skills path where applicable, complete
      interface metadata, and no unsupported fields.
- [ ] Ensure every per-plugin Cursor manifest has a unique kebab-case name,
      strict semver, description, author, homepage, repository, license,
      keywords, and explicit component paths where default discovery would be
      unsafe. Put category in the Cursor marketplace entry. Remove existing
      `displayName`, `publisher`, or per-plugin `category` fields if the live
      Cursor schema does not accept them.
- [ ] Extend the existing Python marketplace test from “both Python plugins are
      present” to “Python entries remain correct inside the complete catalog.”
- [ ] Run the full marketplace contract suite until all ten entries are green.

Run:

```bash
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
python3 tests/plugins/python/test_python_plugins.py -v
git diff --check
```

Expected: exact ten-plugin parity across Claude, Codex, and Cursor, with every
source and declared component resolvable from the repository root.

## Task 9: Document installation, activation differences, and support levels

**Files:**

- Modify: `README.md`
- Create: `docs/plugin-compatibility.md`
- Modify: `tests/README.md`
- Modify: `tests/plugins/marketplaces/README.md`

- [ ] Replace Claude-only plugin overview language with a three-host overview.
- [ ] Document the repository Codex marketplace path and isolated installation
      flow. Do not instruct users to hand-edit installed marketplace files.
- [ ] Document Cursor's root multi-plugin marketplace, team “Import from Repo”
      flow, Customize installation flow, and project/user scope choice.
- [ ] Add a ten-row compatibility matrix using `Native` and `Adapted` exactly as
      defined in this plan.
- [ ] Document activation differences for output styles, lean agents,
      orchestration, project tasks, and command watchdog.
- [ ] State that Codex watchdog coverage is skill-scoped, Cursor watchdog
      coverage is a native hook, and Claude watchdog behavior remains native.
- [ ] State that Cursor public marketplace submission is manual, requires a
      public repository and Cursor review, and is not performed by the
      repository installer.
- [ ] Preserve the existing Python user-scope/project-scope distinction and
      Textual/Rust usage documentation.
- [ ] Verify whether Cursor actually loads `python-scripting/.lsp.json` as a
      plugin component. If the current Cursor schema does not support it,
      document the LSP configuration as Claude-only and the Python quality
      skills as CLI-based on Codex and Cursor.
- [ ] Update the test index with the new structural and hook-adapter suites.

Run:

```bash
rg -n 'Claude Code|Codex|Cursor|Native|Adapted|command-watchdog|lean-agents' \
  README.md docs/plugin-compatibility.md tests/README.md
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
git diff --check
```

Expected: a user can tell what installs, how to activate it, and where host
behavior differs without reading implementation files.

## Task 10: Run automated repository verification

**Files:** no new files unless a failing check identifies a missing test or
documentation correction.

- [ ] Run every new marketplace and watchdog test.
- [ ] Run the existing Python structural and vendor-snapshot tests.
- [ ] Run the existing Textual headless checks affected by shared skill edits.
- [ ] Run repository TypeScript typechecking.
- [ ] Validate every JSON file parses.
- [ ] Check every Markdown file touched by the migration for broken relative
      references.
- [ ] Confirm no generated caches, installed plugin copies, session files,
      secrets, absolute developer paths, or unrelated dirty files entered the
      implementation diff.

Run:

```bash
python3 -m unittest discover -s tests/plugins/marketplaces -p 'test_*.py' -v
python3 -m unittest discover -s tests/plugins/command-watchdog -p 'test_*.py' -v
python3 tests/plugins/project-tasks/test_host_compatibility.py -v
python3 tests/plugins/output-styles/test_output_style_ports.py -v
python3 tests/plugins/python/test_python_plugins.py -v
node --test tests/plugins/python-development/sync-typing-references.test.mjs
node plugins/python-development/scripts/sync-typing-references.mjs --check
npm run typecheck
git diff --check
git status --short
```

Expected: every command passes and the final status lists only intentional
repository changes.

## Task 11: Perform isolated host smoke tests

**Files:** record results in:

- Create: `tests/plugins/marketplaces/codex-smoke-results.md`
- Create: `tests/plugins/marketplaces/cursor-smoke-results.md`

### Codex

- [ ] Use a temporary `CODEX_HOME` under `/tmp`; never use or modify
      `~/.codex`.
- [ ] Add the repository worktree as a non-default local marketplace.
- [ ] List the catalog and verify all ten plugin names appear.
- [ ] Install each plugin into the temporary home and start a fresh thread for
      behavior checks.
- [ ] Exercise at least one representative request per portable skill plugin.
- [ ] Exercise Codex-adapted orchestration, lean routing, output style, project
      tasks, and watchdog wrapping.
- [ ] Record exact Codex version, commands, observed component inventory, and
      pass/fail evidence.
- [ ] Delete only the explicitly created temporary directory after recording
      results.

### Cursor

- [ ] Obtain explicit authorization before writing any local Cursor plugin
      directory or launching the GUI.
- [ ] Load plugins from an isolated local-development location or a disposable
      profile; do not overwrite existing user plugins.
- [ ] Run `Developer: Reload Window` and verify all ten plugins appear in
      Customize with the correct components.
- [ ] Invoke a portable skill, each output-style skill, each lean custom agent,
      project tasks, and both orchestration paths.
- [ ] Run a command matching `watchdog-patterns.txt` and confirm Cursor's
      `preToolUse` adapter rewrites it through `command-watchdog.py`; also verify
      an unmatched command is unchanged.
- [ ] Record exact Cursor version, install scope, component inventory, and
      pass/fail evidence.
- [ ] Remove only the test plugin links/copies created for this run and reload
      Cursor to confirm cleanup.

Expected: both smoke-result files distinguish automated proof from manual
observation and contain no fabricated runs.

## Task 12: Prepare the accepted repository handoff

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Re-check: `README.md`

- [ ] Review the full diff against this plan and the separate Python plan.
- [ ] Confirm every compatibility claim is backed by a test or a clearly marked
      manual result.
- [ ] Remove test caches and temporary artifacts from the worktree.
- [ ] Update `CHANGELOG.md` with the complete Codex/Cursor marketplace work.
- [ ] At the repository's authorized integration boundary, apply the patch
      version consistently to `package.json`, top-level `package-lock.json`, and
      `packages[""]` in the lockfile, following the live `AGENTS.md` rules.
- [ ] Re-run the complete verification sequence after metadata changes.
- [ ] Stop before commit, merge, public Cursor submission, or local
      installation and present the user with the diff and evidence for explicit
      acceptance.

## Acceptance criteria

- [ ] All ten Claude marketplace plugins appear exactly once in both Codex and
      Cursor marketplaces.
- [ ] Every marketplace entry resolves to a valid, matching per-plugin
      manifest and real components.
- [ ] Portable skill plugins work from shared source on both hosts.
- [ ] Orchestration and agent-team skills select safe host-specific mechanisms
      and do not invent missing tools.
- [ ] Cursor loads four custom lean agents; Codex exposes a capability-based
      lean routing skill without claiming to install agent definitions.
- [ ] Concise and terse behavior is invocable on both hosts, with activation
      differences documented.
- [ ] Claude and Cursor watchdog hooks pass protocol tests; Codex watchdog
      wrapping is functional and accurately labeled as skill-scoped.
- [ ] Project Tasks captures and lists data on Claude, Codex, and Cursor and
      preserves the Codex Terra/Luna mapping.
- [ ] Automated verification passes, manual smoke evidence is recorded, and no
      installed configuration was modified without approval.
- [ ] README, compatibility documentation, tests, changelog, and npm metadata
      describe the same final state.
- [ ] The implementation remains uncommitted, unmerged, uninstalled, and
      unpublished until the user explicitly accepts those actions.

## Public Cursor submission follow-up

After implementation is accepted and merged, a separate user-authorized task
may submit the public repository URL through Cursor's publishing flow. Before
submission, re-run the Cursor checklist: public source, valid root marketplace,
unique names, valid per-plugin manifests and relative paths, README usage,
local testing evidence, and optional committed logos. Cursor review and any
requested revisions are external lifecycle work, not completion criteria for
this repository plan.
