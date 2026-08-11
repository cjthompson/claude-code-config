# Claude Opt-In Skills Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a third curses tab ("Skills") to `claude-optin` that renders every discovered skill from the pure `skill_display` model (built on the accepted `ct/claude-optin-skill-model` work) and lets the user cycle its override state with the keyboard, without touching Plugins or MCP Servers behavior.

**Architecture:** Namespace the existing plugin child-row kinds first so the reused `"skill"` row kind is unambiguous, then add small pure helper functions (`build_skill_entries`, `skill_tab_summary`, `sort_skill_entries`) that turn `discover_skills()` + `skill_display()` output into renderer-ready rows — mirroring how `_mcp_entry()` already shapes MCP servers for the shared renderer. Wire the new tab into `run()`/`main()` last, since that part is curses-only and not unit-testable.

**Tech Stack:** Python 3 standard library only (`curses`, `json`, `os`, `unittest`) — same as the rest of `packages/claude-optin`.

## Global Constraints

- Do not change Plugins or MCP Servers tab behavior, appearance, or keybindings.
- Do not modify `skill_display()`'s return shape — `SkillDisplayTests` in `packages/claude-optin/test_claude_optin.py` asserts exact dict equality on it.
- Do not change `Settings.cycle_skill()`'s existing 4-state semantics — it's already tested and used as the general-purpose model method; the Space key needs different (3-visible-state) behavior, so it gets its own method.
- Plugin-backed skills (`skill["source"] == "plugin"`) are always effectively `"on"` and must stay read-only in the new tab — no keypress may attempt to override them.
- Verification command for every task: `python3 packages/claude-optin/test_claude_optin.py -v`
- Manual curses verification is required before Task 8's commit (curses/`run()` logic has no automated test coverage in this codebase — consistent with the existing Plugins/MCP tabs).

---

### Task 1: Namespace plugin child row kinds

**Files:**
- Modify: `packages/claude-optin/claude-optin:588-610` (`build_rows`), `packages/claude-optin/claude-optin:832-837` (render loop's generic detail-row branch)
- Test: `packages/claude-optin/test_claude_optin.py` (`RowBuildingTests`)

**Interfaces:**
- Produces: row kinds `"plugin-skill"`, `"plugin-agent"`, `"plugin-other"` (replacing bare `"skill"`/`"agent"`/`"other"` for plugin children only). `"empty"` and `"mcp-detail"` are unchanged. This frees the bare `"skill"` kind for Task 4's top-level skill rows.

- [x] **Step 1: Write failing test**

Add to `RowBuildingTests` in `packages/claude-optin/test_claude_optin.py`:

```python
    def test_expanded_plugin_uses_namespaced_child_kinds(self):
        plugin = self._plugin("P1")
        plugin["skills"] = [("run", "desc")]
        plugin["agents"] = [("bot", "desc")]
        plugin["other_items"] = [("hooks/pre.sh", "")]
        rows = co.build_rows([plugin], {plugin["key"]})
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds, ["plugin", "plugin-skill", "plugin-agent",
                                  "plugin-other"])
```

- [x] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py -v RowBuildingTests`
Expected: FAIL — `kinds` is `['plugin', 'skill', 'agent', 'other']`, not the namespaced list.

- [x] **Step 3: Rename the kinds in `build_rows`**

In `packages/claude-optin/claude-optin`, replace the plugin branch of `build_rows` (currently lines 596-603):

```python
        if e["kind"] == "plugin":
            for s, desc in e["skills"]:
                rows.append(("plugin-skill", i, f"{s}  {desc}"))
            for a, desc in e["agents"]:
                rows.append(("plugin-agent", i, f"{a}  {desc}"))
            for path, desc in e["other_items"]:
                rows.append(("plugin-other", i, f"{path}  {desc}".rstrip()))
            if not e["skills"] and not e["agents"] and not e["other_items"]:
                rows.append(("empty", i, "(no skills, agents, or other files)"))
```

- [x] **Step 4: Update the render loop's generic detail-row branch**

In the `run()` render loop, replace the tag/color dispatch (currently around line 832-837):

```python
            else:
                tag = {"plugin-skill": "skill", "plugin-agent": "agent",
                       "plugin-other": "other", "empty": "",
                       "mcp-detail": "·"}[kind]
                color = (CYAN if kind == "plugin-agent" else
                         YELLOW if kind == "plugin-other" else 0)
                stdscr.addnstr(y, 11, f"· {tag:<5} {text}", w - 12,
                               color | attr | curses.A_DIM)
```

(Task 4 will add a `"skill-detail"` key to this same dict — not yet.)

- [x] **Step 5: Run test to verify it passes**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: all tests pass, including the new one and the full existing suite (regression check — the visible `tag`/`color` output for expanded plugins is unchanged, only the internal row-kind string changed).

- [x] **Step 6: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "refactor(claude-optin): namespace plugin child row kinds"
```

---

### Task 2: Space-key visible-state cycle on `Settings`

**Files:**
- Modify: `packages/claude-optin/claude-optin:509-519` (add new method next to `cycle_skill`)
- Test: `packages/claude-optin/test_claude_optin.py` (`SkillSettingsTests`)

**Interfaces:**
- Consumes: `Settings.skill_target` (dict, already exists), `SKILL_STATES = ("on", "name-only", "user-invocable-only", "off")` (already exists at module level).
- Produces: `Settings.cycle_skill_visible(address)` — cycles `on -> name-only -> off -> on`, skipping `user-invocable-only` (reachable only via explicit `set_skill(address, "user-invocable-only")`, i.e. the `U` key in Task 7). If the current explicit state happens to be `user-invocable-only` (set via `U`), the next Space press continues to `off` — it does not jump back to `name-only`.

- [x] **Step 1: Write failing test**

Add to `SkillSettingsTests` in `packages/claude-optin/test_claude_optin.py`:

```python
    def test_cycle_skill_visible_skips_user_invocable_only(self):
        settings = self._settings()
        for state in ("name-only", "off", "on"):
            settings.cycle_skill_visible("deploy")
            self.assertEqual(settings.effective_skill("deploy")[0], state)

    def test_cycle_skill_visible_continues_past_explicit_lock(self):
        settings = self._settings()
        settings.set_skill("deploy", "user-invocable-only")
        settings.cycle_skill_visible("deploy")
        self.assertEqual(settings.effective_skill("deploy")[0], "off")
```

- [x] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillSettingsTests`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'cycle_skill_visible'`.

- [x] **Step 3: Implement `cycle_skill_visible`**

Add this method to the `Settings` class in `packages/claude-optin/claude-optin`, directly after `cycle_skill` (after line 519):

```python
    def cycle_skill_visible(self, address):
        """Space-key cycle: on -> name-only -> off -> on. Skips
        user-invocable-only, which is reachable only via explicit set_skill
        (the 'U' key) — but if that's the current state, continues forward
        to 'off' rather than jumping back to 'name-only'."""
        state = self.skill_target.get(address, "on")
        idx = SKILL_STATES.index(state) if state in SKILL_STATES else 0
        next_state = SKILL_STATES[(idx + 1) % len(SKILL_STATES)]
        if next_state == "user-invocable-only":
            next_state = SKILL_STATES[(idx + 2) % len(SKILL_STATES)]
        if next_state == "on":
            self.skill_target.pop(address, None)
        else:
            self.skill_target[address] = next_state
        self.save()
```

- [x] **Step 4: Run test to verify it passes**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: all tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "feat(claude-optin): add Space-key visible skill-state cycle"
```

---

### Task 3: Pure entry-building helpers for the Skills tab

**Files:**
- Modify: `packages/claude-optin/claude-optin` — add before `build_rows` (currently line 588)
- Test: `packages/claude-optin/test_claude_optin.py` (new `SkillEntryTests` class)

**Interfaces:**
- Consumes: skill records from `discover_skills()` (fields: `kind`, `address`, `name`, `source`, `metadata`, `paths`, `collision_paths`, `plugin_key`, `key` — see Step 0 below), and `skill_display(skill, settings)` (returns `{"state", "source", "author_locked", "inert_override", "resident_tokens"}`).
- Produces:
  - `build_skill_entries(skills, settings)` -> list of dicts. Each entry is the original skill record's fields plus `effective_state`, `override_source`, `author_locked`, `inert_override`, `resident_tokens` (renamed from `skill_display`'s `state`/`source` to avoid clashing with the skill record's own `source` field, which means discovery origin — `"personal"`/`"project"`/`"plugin"` — not override scope).
  - `skill_tab_summary(entries)` -> `{"total": int, "on": int, "tokens": int}`.

- [x] **Step 0: Add a `key` field to skill records**

`build_rows` (and the expand-tracking `expanded` set) needs a `"key"` field on every top-level entry, same as plugins (`key = "{name}@{marketplace}"`) and MCP servers (`key = name`). Skill records currently have no `"key"` field. In `packages/claude-optin/claude-optin`, modify `_skill_record` (currently lines 107-118):

```python
def _skill_record(address, name, source, skill_path, metadata, plugin_key=None):
    """Build the renderer-independent representation of one discovered skill."""
    return {
        "kind": "skill",
        "key": address,
        "address": address,
        "name": name,
        "source": source,
        "metadata": metadata,
        "paths": [skill_path],
        "collision_paths": [],
        "plugin_key": plugin_key,
    }
```

This is additive (existing tests key off `s["address"]`, `scoped["metadata"]`, etc. — never a full-dict `assertEqual` on a raw skill record) — run the full suite in Step 2 below to confirm no regression.

- [x] **Step 1: Write failing tests**

Add to `packages/claude-optin/test_claude_optin.py`:

```python
class SkillEntryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.home = self.tempdir.name
        self.repo = os.path.join(self.home, "repo")
        self.old_claude_dir = co.CLAUDE_DIR
        co.CLAUDE_DIR = os.path.join(self.home, ".claude")

    def tearDown(self):
        co.CLAUDE_DIR = self.old_claude_dir
        self.tempdir.cleanup()

    def _skill(self, address="ship", source="personal"):
        return co._skill_record(
            address, "Ship it", source, "/tmp/SKILL.md",
            {"description": "Ship it", "when_to_use": "after tests",
             "disable_model_invocation": False},
        )

    def test_build_skill_entries_merges_display_facts_without_clobbering_origin(self):
        settings = co.Settings(self.repo)
        entries = co.build_skill_entries([self._skill()], settings)
        entry = entries[0]
        self.assertEqual(entry["source"], "personal")          # discovery origin, untouched
        self.assertEqual(entry["override_source"], "default")  # override scope
        self.assertEqual(entry["effective_state"], "on")
        self.assertEqual(entry["key"], "ship")
        self.assertGreater(entry["resident_tokens"], 0)

    def test_skill_tab_summary_counts_on_and_tokens(self):
        settings = co.Settings(self.repo)
        settings.set_skill("off-one", "off")
        entries = co.build_skill_entries(
            [self._skill("on-one"), self._skill("off-one")], settings)
        summary = co.skill_tab_summary(entries)
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["on"], 1)
        self.assertEqual(summary["tokens"],
                         next(e["resident_tokens"] for e in entries
                              if e["address"] == "on-one"))
```

- [x] **Step 2: Run tests to verify they fail**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: `SkillEntryTests` FAILs with `AttributeError: module 'claude_optin' has no attribute 'build_skill_entries'`. Every other test (including `SkillDiscoveryTests` and `SkillDisplayTests`) still PASSes — confirms Step 0's `key` field addition is non-breaking.

- [x] **Step 3: Implement the helpers**

Add this in `packages/claude-optin/claude-optin`, immediately before `def build_rows(display, expanded):` (currently line 588):

```python
def build_skill_entries(skills, settings):
    """Merge discover_skills() records with skill_display() facts into
    renderer-ready entries. Facts use prefixed keys (override_source,
    effective_state) so they don't clobber the record's own 'source'
    field, which means discovery origin (personal/project/plugin), not
    override scope."""
    entries = []
    for skill in skills:
        facts = skill_display(skill, settings)
        entry = dict(skill)
        entry["effective_state"] = facts["state"]
        entry["override_source"] = facts["source"]
        entry["author_locked"] = facts["author_locked"]
        entry["inert_override"] = facts["inert_override"]
        entry["resident_tokens"] = facts["resident_tokens"]
        entries.append(entry)
    return entries


def skill_tab_summary(entries):
    """Header facts for the Skills tab: how many are effectively on, and
    the total resident token cost of the current effective listing."""
    on = sum(1 for e in entries if e["effective_state"] == "on")
    tokens = sum(e["resident_tokens"] for e in entries)
    return {"total": len(entries), "on": on, "tokens": tokens}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: all tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "feat(claude-optin): add key field and entry-building helpers for skills"
```

---

### Task 4: `build_rows` support for top-level skill rows

**Files:**
- Modify: `packages/claude-optin/claude-optin` (`build_rows`, from Task 1's version), render loop's generic detail-row dict (from Task 1 Step 4)
- Test: `packages/claude-optin/test_claude_optin.py` (`RowBuildingTests`)

**Interfaces:**
- Consumes: entries from `build_skill_entries` (Task 3) — specifically `kind` (`"skill"`), `key`, `collision_paths`.
- Produces: row kind `"skill"` for top-level entries (already correct — no rename needed, since Task 1 freed it), `"skill-detail"` for expanded collision-path rows, reusing `"empty"` when there's nothing to show.

- [x] **Step 1: Write failing tests**

Add to `RowBuildingTests` in `packages/claude-optin/test_claude_optin.py`:

```python
    def _skill_entry(self, address, collision_paths=None):
        return {"kind": "skill", "key": address, "address": address,
                "collision_paths": collision_paths or []}

    def test_rows_include_bare_skill_kind(self):
        rows = co.build_rows([self._skill_entry("deploy")], set())
        self.assertEqual([r[0] for r in rows], ["skill"])

    def test_expanded_skill_with_collisions_shows_detail_rows(self):
        entry = self._skill_entry("deploy", collision_paths=["/a/SKILL.md", "/b/SKILL.md"])
        rows = co.build_rows([entry], {entry["key"]})
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds, ["skill", "skill-detail"])
        self.assertEqual(rows[1][2], "/b/SKILL.md")

    def test_expanded_skill_without_collisions_shows_empty_row(self):
        entry = self._skill_entry("deploy")
        rows = co.build_rows([entry], {entry["key"]})
        self.assertEqual([r[0] for r in rows], ["skill", "empty"])
```

- [x] **Step 2: Run tests to verify they fail**

Run: `python3 packages/claude-optin/test_claude_optin.py -v RowBuildingTests`
Expected: FAIL — expanding a `"skill"` entry currently falls into the `else` (MCP) branch of `build_rows` and reads `e["detail_items"]`, which doesn't exist -> `KeyError`.

- [x] **Step 3: Add the skill branch to `build_rows`**

Replace the plugin/mcp if-else in `build_rows` (as left by Task 1) with a three-way branch:

```python
def build_rows(display, expanded):
    """Rows are (kind, entry_index, text). entry_index points into the
    active tab's display list (all plugins, all MCP servers, or all
    skills)."""
    rows = []
    for i, e in enumerate(display):
        rows.append((e["kind"], i, None))
        if e["key"] not in expanded:
            continue
        if e["kind"] == "plugin":
            for s, desc in e["skills"]:
                rows.append(("plugin-skill", i, f"{s}  {desc}"))
            for a, desc in e["agents"]:
                rows.append(("plugin-agent", i, f"{a}  {desc}"))
            for path, desc in e["other_items"]:
                rows.append(("plugin-other", i, f"{path}  {desc}".rstrip()))
            if not e["skills"] and not e["agents"] and not e["other_items"]:
                rows.append(("empty", i, "(no skills, agents, or other files)"))
        elif e["kind"] == "mcp":
            for label, val in e["detail_items"]:
                rows.append(("mcp-detail", i, f"{label}  {val}"))
            if not e["detail_items"]:
                rows.append(("empty", i, "(no connection details)"))
        else:   # skill
            extra_paths = e["collision_paths"][1:] if len(e["collision_paths"]) > 1 else []
            for path in extra_paths:
                rows.append(("skill-detail", i, path))
            if not extra_paths:
                rows.append(("empty", i, "(single source; no collisions)"))
    return rows
```

- [x] **Step 4: Add `"skill-detail"` to the render loop's generic dict**

Update the dict from Task 1 Step 4 (the render loop's `else` branch) to include the new kind:

```python
            else:
                tag = {"plugin-skill": "skill", "plugin-agent": "agent",
                       "plugin-other": "other", "empty": "",
                       "mcp-detail": "·", "skill-detail": "·"}[kind]
                color = (CYAN if kind == "plugin-agent" else
                         YELLOW if kind == "plugin-other" else 0)
                stdscr.addnstr(y, 11, f"· {tag:<5} {text}", w - 12,
                               color | attr | curses.A_DIM)
```

- [x] **Step 5: Run tests to verify they pass**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: all tests pass.

- [x] **Step 6: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "feat(claude-optin): render top-level skill rows and collision detail rows"
```

---

### Task 5: Add the Skills tab to `run()`/`main()` (discovery, tab switch, header)

**Files:**
- Modify: `packages/claude-optin/claude-optin:613-637` (`run()` setup), `packages/claude-optin/claude-optin:938-967` (`main()`)
- No new automated tests — this is curses wiring; verify manually per Task 8's checklist.

**Interfaces:**
- Consumes: `discover_skills(start_dir, repo_root, home, settings)` (existing), `build_skill_entries` and `skill_tab_summary` (Task 3).
- Produces: `run(stdscr, plugins, servers, skills, settings)` — note the added `skills` parameter — and `TAB_NAMES = ["Plugins", "MCP Servers", "Skills"]`.

- [x] **Step 1: Pass discovered skills into `run()` from `main()`**

In `packages/claude-optin/claude-optin`, in `main()` (currently lines 938-963), add skill discovery next to the existing plugin/server discovery, and pass it through:

```python
def main():
    import argparse
    ap = argparse.ArgumentParser(
        prog="claude-optins",
        description="Manage Claude Code plugin, MCP-server, and skill "
                    "opt-ins per repo (default) or user-wide defaults (--global).")
    ap.add_argument("-g", "--global", "--user", dest="global_mode",
                    action="store_true",
                    help="edit user-level defaults in ~/.claude/settings.json "
                         "instead of the repo's .claude/settings.local.json")
    args = ap.parse_args()

    plugins = discover_plugins()
    settings = Settings(find_repo_root(), global_mode=args.global_mode)

    servers = discover_mcp_servers(os.getcwd())
    referenced = set(settings.local_mcp) | set(settings.project_mcp) \
        | set(settings.user_mcp)
    servers = add_orphans(servers, referenced)

    skills = discover_skills(os.getcwd(), find_repo_root(),
                             os.path.expanduser("~"), settings)

    if not plugins and not servers and not skills:
        sys.exit(f"No plugins, MCP servers, or skills found")
    curses.wrapper(run, plugins, servers, skills, settings)
    print(f"Opt-ins saved to {settings.write_path}")
    print("Run /reload-plugins in a live session (or start a new one) to apply.")
```

- [x] **Step 2: Update `run()`'s signature, tab list, and per-frame skill entries**

In `run()` (currently lines 613-637), update the signature and add the Skills tab:

```python
def run(stdscr, plugins, servers, skills, settings):
```

Change `TAB_NAMES` (currently line 637):

```python
    TAB_NAMES = ["Plugins", "MCP Servers", "Skills"]
```

- [x] **Step 3: Build the Skills tab's display list each frame**

In the per-frame block (where `plug` and `srv` are built from `plugins`/`servers` — currently right before `display = list(plug) if tab == 0 else list(srv)`), add a third branch and rebuild skill entries every frame so toggles are reflected immediately:

```python
        skill_entries = build_skill_entries(skills, settings)
        if sort_mode == "name":
            skl = sorted(skill_entries, key=lambda e: e["address"].lower())
        elif sort_mode == "enabled":
            skl = sorted(skill_entries,
                         key=lambda e: (0 if e["effective_state"] == "on" else 1,
                                        e["address"].lower()))
        elif sort_mode == "source":
            skl = sorted(skill_entries,
                         key=lambda e: (SRC_ORDER.get(e["override_source"], 3),
                                        e["address"].lower()))
        elif sort_mode == "tokens":
            skl = sorted(skill_entries, key=lambda e: -e["resident_tokens"])
        else:
            skl = skill_entries
        display = [plug, srv, skl][tab]
```

(This replaces the existing `display = list(plug) if tab == 0 else list(srv)` line — `"skills+agents"` sort mode has no meaning for skills, so it falls through to the unsorted `else` branch, matching how MCP servers already handle that mode.)

- [x] **Step 4: Add Skills tab counts to the header**

In the header-building block (where `enabled_tok`, `on_count`, `off_count` are computed), add:

```python
        skill_summary = skill_tab_summary(skill_entries)
```

And extend `info_segs` (the header line) to include it — add these tuples after the existing MCP count segment:

```python
            (str(skill_summary["total"]), False), (" skills (", True),
            (str(skill_summary["on"]), False), (" on, ~", True),
            (f"{skill_summary['tokens']}", False), (" tok)  ", True),
```

- [x] **Step 5: Manual verification (curses)**

Run `packages/claude-optin/claude-optin` directly (`python3 packages/claude-optin/claude-optin`) in a repo with at least one personal skill under `~/.claude/skills/`. Confirm:
- `Tab` now cycles through three tabs: Plugins, MCP Servers, Skills.
- The Skills tab lists at least one entry (even if rows aren't fully styled yet — Task 6 finishes that).
- The header shows the new skill count segment.
- Switching tabs doesn't crash and Plugins/MCP behavior is visually unchanged.

- [x] **Step 6: Commit**

```bash
git add packages/claude-optin/claude-optin
git commit -m "feat(claude-optin): wire the Skills tab into run()/main()"
```

---

### Task 6: Render skill rows (mark, source tag, name, info columns)

**Files:**
- Modify: `packages/claude-optin/claude-optin` (row-rendering block inside `run()`, alongside the existing `if kind == "plugin":` / `elif kind == "mcp":` branches, currently lines 729-831)
- No new automated tests — curses rendering; verify manually per Task 8's checklist.

**Interfaces:**
- Consumes: skill entries from Task 3/5 (`address`, `name`, `source` [origin], `override_source`, `effective_state`, `author_locked`, `inert_override`, `resident_tokens`, `collision_paths`, `plugin_key`, `key`).

- [x] **Step 1: Add the skill row-rendering branch**

Add a third branch alongside the existing `if kind == "plugin":` (line 729) and `elif kind == "mcp":` (line 790) branches in the render loop:

```python
            elif kind == "skill":
                sk = display[pi]
                state = sk["effective_state"]
                mark, color = {
                    "on": ("✓", GREEN),
                    "name-only": ("~", CYAN),
                    "user-invocable-only": ("u", YELLOW),
                    "off": ("✗", RED),
                }[state]
                src = sk["override_source"]
                src_tag = {"local": "local   ", "project": "project ",
                           "user": "user    "}.get(src, "default ")
                arrow = "▾" if sk["key"] in expanded else "▸"
                name_str = f"{arrow} {sk['address']}"
                origin_tag = "plugin" if sk["source"] == "plugin" else "author"
                lock_str = "L" if sk["author_locked"] else " "
                warn_str = "!" if sk["inert_override"] else " "
                collision_n = len(sk["collision_paths"])
                collision_str = f"x{collision_n}" if collision_n > 1 else "  "
                info_segs = [
                    ("[ ", True), (origin_tag, False), (" ", True),
                    (lock_str, False), (warn_str, False), (" ", True),
                    (collision_str, False), (" ~", True),
                    (f"{sk['resident_tokens']:>3}", False), (" tok ]", True),
                ]
                info_str = "".join(seg for seg, _ in info_segs)
                name_color = (DIM_WHITE | curses.A_DIM if sk["source"] == "plugin"
                              else color)
                stdscr.addnstr(y, 0, " ", 1, attr)
                stdscr.addnstr(y, 1, mark, 1, color | attr | curses.A_BOLD)
                editable = "user" if settings.global_mode else "local"
                stdscr.addnstr(y, 2, f" {src_tag}", 9,
                               (YELLOW if src == editable else curses.A_DIM) | attr)
                info_col = w - len(info_str) - 1
                if info_col > 11:
                    name_width = max(1, info_col - 12)
                    stdscr.addnstr(y, 11, name_str, name_width, name_color | attr)
                    ix = info_col
                    for seg, is_label in info_segs:
                        if ix >= w - 1:
                            break
                        n = min(len(seg), w - 1 - ix)
                        stdscr.addnstr(y, ix, seg, n,
                                       (curses.A_DIM if is_label else 0) | attr)
                        ix += len(seg)
                else:
                    name_width = max(1, w - 12)
                    stdscr.addnstr(y, 11, name_str, name_width, name_color | attr)
```

`sk["source"] == "plugin"` renders the name dimmed white — same visual treatment `uninstalled`/`deleted` plugins get — so plugin-backed (always-on, read-only) skills are visually distinct from personal/project skills a user can actually toggle.

- [x] **Step 2: Manual verification (curses)**

With the same manual setup as Task 5 Step 5, confirm on the Skills tab:
- Every skill shows a mark (`✓`/`~`/`u`/`✗`) matching its actual effective state.
- The source tag column (`local`/`project`/`user`/`default`) matches where the override (if any) lives.
- A plugin-backed skill (install a test plugin with a skill, or fake one via cache dir) renders dimmed and always shows `✓`.
- Expand (`l`) on a skill with more than one discovery path (e.g. create the same skill name under both `~/.claude/skills/` and `.claude/skills/` in a test repo) shows the extra path(s) as detail rows; a skill with only one path shows the `(single source; no collisions)` empty row instead.
- An explicit override that's currently inert (e.g. an override on a plugin-backed skill, or one that conflicts with an author lock) shows the `!` warning.

- [x] **Step 3: Commit**

```bash
git add packages/claude-optin/claude-optin
git commit -m "feat(claude-optin): render skill rows in the Skills tab"
```

---

### Task 7: Keyboard input — Space / O / U / C on skill rows

**Files:**
- Modify: `packages/claude-optin/claude-optin` (input-handling block inside `run()`, currently lines 879-935)
- No new automated tests — curses input dispatch; verify manually per Task 8's checklist. `Settings.cycle_skill_visible`, `set_skill`, and `clear_skill` are already unit-tested (Task 2 and pre-existing).

**Interfaces:**
- Consumes: `entry = display[pi]` where `pi` comes from `rows[cursor]` — for a `"skill"` row, `pi` now correctly indexes the skill's own entry (not a parent plugin), because Task 1 removed the `"skill"` kind's collision with plugin children. This also fixes the pre-existing bug where pressing Space on a plugin's expanded skill sub-row toggled the parent plugin instead of doing nothing.

- [x] **Step 1: Extend the Space/Enter handler**

The existing handler (currently lines 911-919):

```python
        elif ch in (ord(" "), ord("\n"), curses.KEY_ENTER) and entry:
            if entry["kind"] == "plugin":
                _, src = settings.effective(entry["key"], entry["installed"])
                if src not in ("uninstalled", "deleted"):
                    settings.cycle(entry["key"])
                    notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
            elif entry["kind"] == "mcp":
                settings.cycle_mcp(entry["name"])
                notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
```

Add a `"skill"` branch:

```python
        elif ch in (ord(" "), ord("\n"), curses.KEY_ENTER) and entry:
            if entry["kind"] == "plugin":
                _, src = settings.effective(entry["key"], entry["installed"])
                if src not in ("uninstalled", "deleted"):
                    settings.cycle(entry["key"])
                    notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
            elif entry["kind"] == "mcp":
                settings.cycle_mcp(entry["name"])
                notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
            elif entry["kind"] == "skill" and entry["source"] != "plugin":
                settings.cycle_skill_visible(entry["address"])
                notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
```

(Plugin-backed skills, `entry["source"] == "plugin"`, are silently ignored — same treatment `uninstalled`/`deleted` plugins get in the plugin branch above.)

- [x] **Step 2: Add O / U / C handlers**

Add these as new `elif` branches in the same key-dispatch chain (near the `elif ch == ord("D")` branch, currently line 933):

```python
        elif ch == ord("O") and entry and entry["kind"] == "skill" \
                and entry["source"] != "plugin":
            settings.set_skill(entry["address"], "on")
            notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
        elif ch == ord("U") and entry and entry["kind"] == "skill" \
                and entry["source"] != "plugin":
            settings.set_skill(entry["address"], "user-invocable-only")
            notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
        elif ch == ord("C") and entry and entry["kind"] == "skill" \
                and entry["source"] != "plugin":
            settings.clear_skill(entry["address"])
            notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
```

- [x] **Step 3: Update the footer hint (Skills tab only)**

In the footer-building block (`footer_segs`, currently around line 848-859), add the new keys only when the Skills tab is active:

```python
            if tab == 0:   # delete is plugin-only
                footer_segs += [("D", True), (":delete  ", False)]
            if tab == 2:   # explicit skill states are Skills-tab-only
                footer_segs += [("O", True), (":on  ", False),
                                ("U", True), (":user-only  ", False),
                                ("C", True), (":clear  ", False)]
```

- [x] **Step 4: Manual verification (curses)**

Using the same manual setup as Tasks 5-6, on the Skills tab:
- Space on a personal/project skill cycles `on -> name-only -> off -> on` (confirm it never lands on `user-invocable-only`).
- `O` on a skill sets it to explicit `on` (verify by checking the written `.claude/settings.local.json` — the address should appear with value `"on"`, not be absent).
- `U` sets it to `user-invocable-only`; a subsequent Space press continues to `off`, not back to `name-only` (per Task 2's `cycle_skill_visible` semantics).
- `C` clears the override at the current write scope (the address disappears from `skillOverrides` in the write-target file) and effective state falls back to whatever the next layer resolves to.
- Space/O/U/C on a plugin-backed skill row do nothing (no notification, no settings write).
- Toggling on the Skills tab does not affect the Plugins or MCP Servers tabs' saved state.

- [x] **Step 5: Commit**

```bash
git add packages/claude-optin/claude-optin
git commit -m "feat(claude-optin): wire Space/O/U/C keys to skill overrides"
```

---

### Task 8: Docs, manifest, version bump, changelog, final verification

**Files:**
- Modify: `packages/claude-optin/claude-optin:1-28` (module docstring), `packages/claude-optin/README.md`, `packages/claude-optin/manifest.json` (`description` only — not `example`), `package.json`, `package-lock.json`, `CHANGELOG.md`

- [x] **Step 1: Update the module docstring**

In `packages/claude-optin/claude-optin`, update the docstring (currently lines 1-28) to describe the third tab and its keys. Replace the "Keys:" block's tab/state description:

```python
"""claude-optins — TUI to manage per-repo Claude Code opt-ins.

Run from inside a repo. Manages three things that add to a session's
startup context, in three tabs switched with TAB:

  • Plugins — every installed plugin (with its skills and agents), its
    effective enabled state, and where that comes from.
  • MCP servers — every server defined in a .mcp.json found walking from
    the current directory up to your home directory, plus user-scope
    servers in ~/.claude.json. Toggling moves a name between the
    enabledMcpjsonServers / disabledMcpjsonServers lists; a disabled
    server stays defined but isn't started, so it costs no context.
  • Skills — every discovered skill (personal, project, and active-plugin),
    its effective on/name-only/user-invocable-only/off state, and its
    resident token cost. Plugin-backed skills are always on and read-only.

Keys:
  tab           switch Plugins / MCP Servers / Skills tab
  j/k, arrows   move          space/enter  cycle (Plugins/MCP: on<->off;
                                            Skills: on -> name-only -> off)
  l/right       expand        h/left       collapse
  a             expand/collapse all        g/G  top/bottom
  s             cycle sort: default / name / enabled / source / skills+agents / tokens
  D             delete plugin (removes cache dir, prompts; Plugins tab only)
  O/U/C         Skills tab only: explicit on / user-invocable-only / clear override

Toggles are written to <repo>/.claude/settings.local.json (gitignored,
personal). With --global / -g / --user, toggles edit the user-level
defaults in ~/.claude/settings.json instead. Run /reload-plugins inside a
live Claude Code session, or start a new session, to pick up changes.
"""
```

- [x] **Step 2: Update `packages/claude-optin/README.md`**

Add a "Skills" bullet to the "It manages ... in two tabs" intro (change "two tabs" to "three tabs" and add the Skills bullet), add `O`/`U`/`C` rows to the Keys table (noting they're Skills-tab-only), and add a short "### Skills" subsection under "How it works" documenting the four states (`on`, `name-only`, `user-invocable-only`, `off`) and that plugin-backed skills are always on. Follow the existing subsection style used for "MCP servers" (states table + one-paragraph explanation).

- [x] **Step 3: Update the manifest description**

In `packages/claude-optin/manifest.json`, update only the `"description"` field (leave `"example"` untouched, per the task requirement) to mention skills:

```json
    "description": "TUI to manage per-repo Claude Code opt-ins for plugins, MCP servers, and skills. Lists installed plugins (with skills and agents), MCP servers discovered from .mcp.json files plus ~/.claude.json, and every discovered skill (personal, project, and active-plugin) with its effective on/name-only/user-invocable-only/off state. Shows each entry's source (user / project / local) and toggles overrides written to .claude/settings.local.json (or ~/.claude/settings.json with --global).",
```

- [x] **Step 4: Bump the patch version in both `package.json` and `package-lock.json`**

Check current version first:

```bash
grep -n '"version"' package.json package-lock.json | head -5
```

Bump the patch version by one in `package.json`'s `"version"` field, and in **both** places in `package-lock.json`: the top-level `"version"` field and the root package entry under `"packages": {"": {...}}`. Verify all three landed together:

```bash
grep -n '"version"' package-lock.json | head -2
```

- [x] **Step 5: Add the dated `CHANGELOG.md` entry**

Add an entry at the top of `CHANGELOG.md`, heading `## v<new-version> - 2026-08-11`, following the existing house style (see the `v0.0.59` entry for format: a `### Changes` list with one bullet per notable change). Summarize: the new Skills tab, the Space/O/U/C keybindings, the plugin-child-row-kind namespacing, and that plugin-backed skills are read-only.

- [x] **Step 6: Full verification**

```bash
python3 packages/claude-optin/test_claude_optin.py -v
git diff --check
git status --short
```

Expected: all tests pass (regression + everything added across Tasks 1-7); no whitespace errors; only the files listed above plus the executable and its tests are changed.

- [x] **Step 7: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/README.md \
        packages/claude-optin/manifest.json package.json package-lock.json CHANGELOG.md
git commit -m "docs(claude-optin): document the Skills tab and bump version"
```

- [x] **Step 8: Report and ask about `install-packages`**

Per this repo's `CLAUDE.md` convention: after `packages/` changes are committed, report to the user that the package changes are ready and ask (via `AskUserQuestion`) whether to run `npm run install-packages`.
