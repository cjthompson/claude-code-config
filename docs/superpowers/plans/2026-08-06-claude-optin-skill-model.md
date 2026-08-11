# Claude Opt-In Skill Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build and test a pure model for skill metadata, discovery, settings overrides, display state, and resident context cost.

**Architecture:** Keep parsing and discovery as module-level data-layer functions. Extend `Settings` for persistence and resolution, then add a pure `skill_display()` function; do not touch curses rendering.

**Tech Stack:** Python 3 standard library: `json`, `os`, `re`, `tempfile`, and `unittest`.

---

## File structure

- `packages/claude-optin/claude-optin` — frontmatter parsing, discovery, skill override APIs, and display model.
- `packages/claude-optin/test_claude_optin.py` — temporary-filesystem unit coverage of the data layer.

### Task 1: Parse skill metadata

**Files:**
- Modify: `packages/claude-optin/claude-optin:56-71`
- Test: `packages/claude-optin/test_claude_optin.py`

- [x] **Step 1: Write failing parser tests**

Add `SkillFrontmatterTests` with a helper that writes `SKILL.md`. Exercise plain/quoted fields, folded/literal values, and true/false/absent `disable-model-invocation`.

```python
def test_parses_scalars_and_boolean(self):
    meta = co.parse_frontmatter(self._skill("""---
name: deploy
description: "Deploy the service"
when_to_use: 'after a release'
disable-model-invocation: true
---
"""))
    self.assertEqual(meta, {"name": "deploy", "description": "Deploy the service",
                            "when_to_use": "after a release",
                            "disable_model_invocation": True})

def test_parses_folded_and_literal_blocks(self):
    meta = co.parse_frontmatter(self._skill("""---
description: >
  First line
  second line
when_to_use: |
  first command
  second command
---
"""))
    self.assertEqual(meta["description"], "First line second line")
    self.assertEqual(meta["when_to_use"], "first command\nsecond command")
    self.assertFalse(meta["disable_model_invocation"])
```

- [x] **Step 2: Verify RED**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillFrontmatterTests`

Expected: the current tuple-returning parser fails the metadata assertions.

- [x] **Step 3: Implement metadata parsing**

Replace `parse_frontmatter()` with a dict-returning parser for only the opening `---` block. It returns `{}` for unreadable/missing frontmatter. It recognizes `name`, `description`, `when_to_use`, and `disable_model_invocation`; strips matching quotes; folds nonblank `>` continuations with spaces; preserves `|` newlines; and turns only `true` into the boolean flag. Update `discover_plugins()` to read `meta.get("name")` and `meta.get("description", "")`.

```python
def _frontmatter_scalar(value):
    value = value.strip()
    return value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"" else value

def parse_frontmatter(path):
    # Return parsed metadata dict; do not parse document body.
```

- [x] **Step 4: Verify GREEN**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillFrontmatterTests`

Expected: all parser tests pass.

### Task 2: Discover and collapse skill records

**Files:**
- Modify: `packages/claude-optin/claude-optin:82-161`
- Test: `packages/claude-optin/test_claude_optin.py`

- [x] **Step 1: Write failing discovery tests**

Use a temporary home, repository, cache, registry, and settings docs. Assert personal, root, scoped project, active installed-plugin, disabled-plugin, stale-cache, and collision results.

```python
def test_discovers_personal_root_and_scoped_project_skills(self):
    skills = co.discover_skills(os.path.join(self.repo, "apps", "web"),
                                self.repo, self.home, self.settings)
    self.assertEqual({s["address"] for s in skills},
                     {"deploy", "apps/web:deploy", "personal-only"})

def test_collapses_collisions_and_excludes_inactive_plugins(self):
    skills = co.discover_skills(self.repo, self.repo, self.home, self.settings)
    deploy = next(s for s in skills if s["address"] == "deploy")
    self.assertEqual(len(deploy["collision_paths"]), 2)
    self.assertIn("active:run", {s["address"] for s in skills})
    self.assertNotIn("stale:run", {s["address"] for s in skills})
    self.assertNotIn("disabled:run", {s["address"] for s in skills})
```

- [x] **Step 2: Verify RED**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillDiscoveryTests`

Expected: failure because `discover_skills` does not exist.

- [x] **Step 3: Implement record construction and discovery**

Add `_skill_record()`, `_merge_skill()`, and `discover_skills(start_dir, repo_root, home, settings, claude_dir=None, cache_dir=None, installed_plugins_path=None)`. Project root addresses are bare skill directory names; nested directory addresses are `<repo-relative-directory>:<skill-directory>`. Plugin addresses are `<plugin-name>:<frontmatter-name-or-directory>`. Read cache skill folders only when the registry contains `plugin@marketplace` and `settings.effective(key, installed=True)[0]` is true. Every record includes `kind`, `address`, `name`, `source`, `metadata`, `paths`, `collision_paths`, and `plugin_key`.

```python
def _merge_skill(found, record):
    current = found.get(record["address"])
    if current is None:
        record["collision_paths"] = list(record["paths"])
        found[record["address"]] = record
    else:
        current["collision_paths"].extend(record["paths"])

def discover_skills(start_dir, repo_root, home, settings, **paths):
    found = {}
    # collect personal, project, then enabled installed-plugin records
    return sorted(found.values(), key=lambda skill: skill["address"].lower())
```

- [x] **Step 4: Verify discovery and regression coverage**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillDiscoveryTests`

Expected: all skill discovery tests pass.

Run: `python3 packages/claude-optin/test_claude_optin.py -v`

Expected: all parser, discovery, existing MCP, plugin-count, and row tests pass.

### Task 3: Resolve and mutate skill overrides

**Files:**
- Modify: `packages/claude-optin/claude-optin:282-383`
- Test: `packages/claude-optin/test_claude_optin.py`

- [x] **Step 1: Write failing settings tests**

Test qualified-first resolution, each scope’s precedence, every cycle transition, invalid states, clear cleanup, and preservation of plugin/MCP settings.

```python
def test_qualified_override_wins_before_plain_name(self):
    self._write_settings(user={"skillOverrides": {"deploy": "off"}},
                         local={"skillOverrides": {"apps/web:deploy": "name-only"}})
    self.assertEqual(self._settings().effective_skill("apps/web:deploy"),
                     ("name-only", "local"))

def test_cycles_and_clears_without_clobbering_other_keys(self):
    settings = self._settings()
    for state in ("name-only", "user-invocable-only", "off", "on"):
        settings.cycle_skill("deploy")
        self.assertEqual(settings.effective_skill("deploy")[0], state)
    settings.clear_skill("deploy")
    self.assertNotIn("skillOverrides", load_doc(self.local_path))
```

- [x] **Step 2: Verify RED**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillSettingsTests`

Expected: failure because `skillOverrides` and the skill APIs are absent.

- [x] **Step 3: Implement `Settings` skill APIs**

Load `skillOverrides` for user/project/local docs alongside the existing maps. Define `SKILL_STATES`, `effective_skill`, `set_skill`, `cycle_skill`, and `clear_skill`. Qualified address resolution iterates local/project/user before any unqualified fallback. `cycle_skill` transitions `on → name-only → user-invocable-only → off → on` by clearing the explicit entry at the last transition. `save()` removes an empty `skillOverrides` map only.

```python
SKILL_STATES = ("on", "name-only", "user-invocable-only", "off")

def effective_skill(self, address):
    for candidate in (address, address.rsplit(":", 1)[-1]):
        for layer, source in ((self.local_skills, "local"), (self.project_skills, "project"),
                              (self.user_skills, "user")):
            if candidate in layer:
                return layer[candidate], source
    return "on", "default"
```

- [x] **Step 4: Verify settings and regression coverage**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillSettingsTests`

Expected: all skill settings tests pass.

Run: `python3 packages/claude-optin/test_claude_optin.py -v`

Expected: all tests pass, including existing MCP and plugin behavior.

### Task 4: Build pure display facts

**Files:**
- Modify: `packages/claude-optin/claude-optin:before build_rows`
- Test: `packages/claude-optin/test_claude_optin.py`

- [x] **Step 1: Write failing display tests**

Use ordinary, author-locked, and active-plugin records to assert exact state/source/lock/inert facts and costs for all override states.

```python
def test_skill_display_costs_follow_effective_state(self):
    skill = self._skill_record(description="Ship it", when_to_use="after tests")
    self.assertGreater(co.skill_display(skill, self._settings_with("on"))["resident_tokens"], 0)
    self.assertGreater(co.skill_display(skill, self._settings_with("name-only"))["resident_tokens"], 0)
    self.assertEqual(co.skill_display(skill, self._settings_with("user-invocable-only"))["resident_tokens"], 0)
    self.assertEqual(co.skill_display(skill, self._settings_with("off"))["resident_tokens"], 0)

def test_plugin_and_author_locks_make_override_inert(self):
    self.assertTrue(co.skill_display(self._plugin_skill(), self.settings)["inert_override"])
    self.assertTrue(co.skill_display(self._locked_skill(), self.settings)["author_locked"])
```

- [x] **Step 2: Verify RED**

Run: `python3 packages/claude-optin/test_claude_optin.py -v SkillDisplayTests`

Expected: failure because `skill_display` does not exist.

- [x] **Step 3: Implement `skill_display`**

Add a pure `skill_display(skill, settings)` before `build_rows()`. An active plugin forces `on`; `disable_model_invocation` forces `user-invocable-only`; either case marks an explicit non-default setting as inert. Estimate tokens with ceiling division: `on` uses command name + description + when-to-use, `name-only` uses the command name, and the other two states use zero.

```python
def _token_estimate(text):
    return (len(text) + 3) // 4 if text else 0

def skill_display(skill, settings):
    requested, source = settings.effective_skill(skill["address"])
    plugin = skill.get("source") == "plugin"
    locked = bool(skill["metadata"].get("disable_model_invocation"))
    state = "on" if plugin else "user-invocable-only" if locked else requested
    text = "" if state in ("off", "user-invocable-only") else skill["name"]
    if state == "on":
        text += skill["metadata"].get("description", "") + skill["metadata"].get("when_to_use", "")
    return {"state": state, "source": source, "author_locked": locked,
            "inert_override": source != "default" and state != requested,
            "resident_tokens": _token_estimate(text)}
```

- [x] **Step 4: Run final verification and commit**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`

Expected: every test passes.

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the executable, its tests, and planning documentation are changed.

```sh
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py docs/superpowers/plans/2026-08-06-claude-optin-skill-model.md
git commit -m "feat(claude-optin): model effective skill state"
```
