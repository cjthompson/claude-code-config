# claude-optin: manage Claude Code's per-project trust flag

## Context

`.claude/settings.local.json` got created for a project, but Claude Code still
treats it as untrusted, and the "do you trust this folder?" prompt no longer
appears — so there is no UI path back to a trusted state.

- No existing plan/task covers this; `claude-optin` only *reads*
  `~/.claude.json` today (MCP discovery).
- Claude Code has no parent-directory / glob trust mechanism (upstream issues
  [#12737](https://github.com/anthropics/claude-code/issues/12737),
  [#29285](https://github.com/anthropics/claude-code/issues/29285),
  [#23109](https://github.com/anthropics/claude-code/issues/23109),
  [#45298](https://github.com/anthropics/claude-code/issues/45298)).
- The symptom matches [#72896](https://github.com/anthropics/claude-code/issues/72896):
  dialog suppression walks ancestors, but applied trust requires an exact key.

Goal: teach `claude-optin` to read, diagnose, and write
`~/.claude.json` → `projects["<key>"].hasTrustDialogAccepted`, per exact key.

**Scope:** CLI flags (Task 1) and a TUI Trust tab (Task 2). Default range is the
current project; `-g`/`--global` lists every `projects` entry.

## Verified against the installed binary (v2.1.280)

- **Only trust field:** `hasTrustDialogAccepted`. There is no
  `isWorkspacePersistedTrusted`.
- **Applied-trust check** (`uwe`/`pMn`): exact lookup
  `projects[key]?.hasTrustDialogAccepted === true`, where `key` = git root of
  cwd if any, else the resolved cwd, then path-normalized.
- **Dialog-suppression check** (`SO`/`j_`/`Y_`): exact key first, then walks
  from the resolved cwd up through ancestors, bounded by the git root when one
  exists, returning true at the first ancestor with the flag. This is the
  mismatch: an ancestor can suppress the dialog without the exact key ever
  being trusted.
- **Key form:** existing keys are realpath'd (`/private/tmp/...`, not
  `/tmp/...`). No worktree paths appear as keys — worktree keying is
  unconfirmed; verify empirically (see Task 1).
- **Claude's own writer** (`q_`): no-op if already true; otherwise
  `{...projects[key] ?? DEFAULT, hasTrustDialogAccepted: true}` where
  `DEFAULT = {allowedTools: [], mcpContextUris: [], mcpServers: {},
  enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false}`.
- **Home directory:** trust there is session-only; persisted trust for `$HOME`
  is ignored. `--trust` on `$HOME` must warn.
- **Per-project fields** that may be present: `projectOnboardingSeenCount`,
  `hasCompletedProjectOnboarding` (absent from most entries — render only when
  present).
- **Live sessions** cache the config and rewrite the whole file; a running
  session can clobber an external edit. Changes are reliable for *new*
  sessions; re-verify after writing.

## Global constraints

- Python 3 stdlib only. All code in `packages/claude-optin/claude-optin`; all
  tests in `packages/claude-optin/test_claude_optin.py` (`unittest`,
  `tempfile.TemporaryDirectory()`).
- Tests never touch the real `~/.claude.json`: override `co.CLAUDE_JSON_PATH`
  to a temp file in every trust test.
- Never read/write under `~/.claude/` from this repo.
- Existing Plugins / MCP Servers / Skills behavior must not change.
- Follow TDD: failing test first for each new function.
- Do not run `--untrust` against this repo while a Claude session is live here;
  manual tests use a scratch git repo.
- Branches: `ct/claude-optin-trust-cli` (Task 1) cut from `local/main` after
  `git fetch local` (this clone has no `origin`). Task 2's branch
  `ct/claude-optin-trust-tab` is cut from `local/main` only after Task 1 has
  merged to `main` — Task 2 calls Task 1's helpers in the same file and would
  not run without them.
- Version bump / `CHANGELOG.md` happen on `main` after merge, per repo
  `CLAUDE.md` — not on the feature branches.

## Task 1: Trust helpers and CLI flags

Add to `packages/claude-optin/claude-optin`:

- **`load_json_strict(path)`** — raises on `OSError`/`JSONDecodeError` and on a
  non-dict top level. Never reuse `load_json` (line ~52) for writes: it returns
  `{}` on error, and writing that back would wipe `~/.claude.json`.
- **`resolve_trust_key(start_dir=None) -> str`** — `realpath` of the nearest
  ancestor containing `.git` (directory or file), else `realpath(start_dir)`.
  Separate from `find_repo_root()`, which also treats a bare `.claude/` as a
  root. Before finalizing, verify worktree keying on a scratch repo + worktree
  (accept trust in a worktree via `claude`, inspect which key appears) and
  match it; document the result in a code comment only if non-obvious.
- **`discover_trust_entries(user_json_path=None) -> list[dict]`** — one dict per
  `projects` key: `{"path", "trusted": bool, "onboarding_seen_count": int|None,
  "has_completed_onboarding": bool|None}`, sorted by path. Read-only; may use
  `load_json`.
- **`get_trust(path, user_json_path=None) -> bool|None`** — `None` = no entry.
- **`trust_suppressor(path, user_json_path=None) -> str|None`** — mirrors `Y_`:
  walk from `path` up to (and including) its git root (unbounded when there is
  no git root); return the first ancestor *other than* `path` whose flag is
  true, else `None`.
- **`set_trust(path, value, user_json_path=None) -> (old, new)`** — strict
  read; no-op if unchanged; create a missing entry from the `DEFAULT` object
  above; write via temp file in the same directory + `os.replace`, preserving
  the original file mode (`mkstemp` defaults to `0600`); `json.dump(...,
  indent=2, ensure_ascii=False)`. Every other key at every level is preserved
  (value-identical; float formatting may differ from JS, which is acceptable).
- **CLI** (in `main()`, early non-interactive exits before building the TUI):
  - `--trust [PATH]` / `--untrust [PATH]` — `set_trust(PATH or
    resolve_trust_key(cwd), True/False)`; print `path: old → new`; warn when
    the key is `$HOME` (session-only trust); remind that running sessions may
    overwrite the change.
  - `--trust-status` — without `-g`: current key, its state (`trusted` /
    `untrusted` / `no entry`), and, if untrusted, the suppressing ancestor from
    `trust_suppressor` with a one-line explanation of the mismatch. With `-g`:
    every entry, current key marked.

Tests (new classes in `test_claude_optin.py`):
- strict loader raises on malformed / non-object JSON; `set_trust` leaves a
  malformed file untouched.
- `set_trust` preserves unrelated top-level and per-project keys, creates the
  default object for a new entry, is a no-op when unchanged (mtime unchanged),
  preserves file mode.
- `get_trust` distinguishes `None` vs `False`.
- `resolve_trust_key` with `.git` dir, `.git` file, bare `.claude/` (not a
  root), and a symlinked path (realpath).
- `trust_suppressor` finds an ancestor within the git root and ignores one
  above it.
- CLI flags via `main()` with patched `sys.argv` and `CLAUDE_JSON_PATH`.

README: new "Trust" section covering the flags, the `-g` difference, the
#72896 mismatch explanation, the `$HOME` caveat, and the live-session caveat.
`manifest.json`: mention trust in `description`.

## Task 2: Trust tab in the TUI

Depends on Task 1 (merged to `main`).

- `TAB_NAMES` gains `"Trust"`. Rows: without `-g`, the single current key
  (shown even when there is no entry); with `-g`, one row per
  `discover_trust_entries()`, current key visually marked.
- New row kind `trust` in `build_rows` and the renderer; add it to the row-kind
  tuple used when collapsing (line ~1197).
- `space`/`enter` on a trust row enters the existing `confirming` flow. Make
  `confirming` kind-aware — today it looks up `plugins` and builds a plugin
  label (lines ~1090–1097, ~1139–1151). Footer: `Trust <path>?` / `Untrust
  <path>?` with the same `y = confirm   any other key = cancel` pattern. On `y`
  call `set_trust` and show the `saved` badge; on a strict-load error show an
  error badge and change nothing.
- `l`/right expands read-only detail rows (onboarding fields when present, and
  the suppressing ancestor when untrusted) using the `detail_items` convention.
- Header info line on this tab: trusted/untrusted counts, same style as the
  Plugins on/off counts.
- Footer on this tab: hide `O`/`U`/`C`/`D` hints.
- Update the empty-state `sys.exit` (line ~1231) so the TUI still opens when
  only the Trust tab has content.
- Tests: `build_rows` trust branch (global and non-global), kind-aware confirm
  label helper, header count summary.
- README: Trust tab keys and confirmation behavior.

## Verification

1. `python3 packages/claude-optin/test_claude_optin.py -v` — full suite green;
   grep confirms every trust test overrides `CLAUDE_JSON_PATH`.
2. Copy the real `~/.claude.json` to the session scratchpad, run `set_trust` on
   the copy for one key, and `diff` pretty-printed before/after (`jq -S`):
   only that key changes.
3. Scratch git repo: `--trust-status` → `--trust` → `--trust-status`; start
   `claude` there and confirm no prompt and trusted behavior; `--untrust` and
   confirm the prompt returns.
4. (Task 2) TUI: switch to Trust, toggle, confirm with `y`, check the on-disk
   entry flipped; `-g` lists all entries and toggling one leaves the others
   untouched.
