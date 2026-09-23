# claude-optin Skills Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third tab to `claude-optin` that truthfully shows every active skill contributing to the current session's model listing, its effective source/state/cost, and the controls that can actually turn that skill down or off.

**Architecture:** Follow the shape already established by the MCP tab, but put a pure effective-skill model between discovery and curses. Discovery scans personal skills, root and directory-scoped project skills, and effectively enabled plugin roots; it collapses duplicate addresses into one control and retains collision details. `Settings` resolves the qualified address across the full user/project/local cascade before trying the unqualified fallback. A pure `skill_display` function applies plugin and author locks and computes the effective listing cost; the TUI renders only that model. All logic remains in `packages/claude-optin/claude-optin`, with tests in the existing `unittest` file.

**Tech Stack:** Python 3 stdlib only (`curses`, `json`, `os`, `re`) — no new dependencies. Tests use `unittest` via `python3 packages/claude-optin/test_claude_optin.py`.

## Global Constraints

- Python 3 stdlib only. No new dependencies; `claude-optin` is installed as a bare file to `~/.local/bin`.
- All production code goes in `packages/claude-optin/claude-optin`. Do not split the script.
- All tests go in `packages/claude-optin/test_claude_optin.py`, `unittest` style, using `tempfile.TemporaryDirectory()` and the existing `write_json` / `load_doc` helpers.
- Tests must not read or write real `~/.claude` paths. Override `co.CLAUDE_DIR` and `co.CACHE_DIR` to temp dirs, as `PluginCountTests` already does.
- Never read or write files directly under `~/.claude/` from this repo (repo `CLAUDE.md`). Reading the Claude Code *binary* under `~/.local/share/claude/` is fine.
- Existing behaviour of the Plugins and MCP Servers tabs must not change, except for the row-kind rename in Task 4.
- Repo is under `~/dev` → personal project, no CI, **no PR required**. Keep branch discipline: cut the first slice from `origin/main` after `git fetch`; base the dependent second slice on the accepted first-slice commit. Name both branches `ct/<slug>`.
- After each commit on `main`, repo `CLAUDE.md` requires a `package.json` patch bump + `CHANGELOG.md` entry. Task 7 covers this once, at the end.
- Execute in two stacked worktrees: the tested discovery/effective-model slice on
  `ct/claude-optin-skill-model`, then the TUI/documentation slice on
  `ct/claude-optin-skills-tab` based on the accepted model commit. Use
  `.Codex/worktrees/<branch-name>` for both and add `.Codex/worktrees/` to
  `.git/info/exclude` if necessary.

---

## Background: verified `skillOverrides` semantics

These were read out of the Claude Code 2.1.223 binary, not assumed. Re-verify with
`grep -ao '.\{120\}skillOverrides.\{260\}' ~/.local/share/claude/versions/<ver>/claude`
if the behaviour ever looks wrong.

**1. The setting is a four-valued enum, not a boolean.**

```
skillOverrides: record(string, enum(["on", "name-only", "user-invocable-only", "off"]))
```

Its own description string:

> Per-skill listing overrides keyed by skill name. "name-only" lists the skill without its description; "user-invocable-only" hides it from the model but keeps /name; "off" hides it from both. Absent = on.

**`name-only` is the headline feature for this tool.** The listing builder emits
`- ${name}: ${description}` normally but `- ${name}` for a `name-only` skill, so
it strips the description — typically 90% of a skill's resident cost — while
leaving the skill fully usable. That is a strictly better lever than `off` for
anything you still want available, and no other tool surfaces it well.

**2. Resolution is qualified-name-first, then unqualified.**

```js
n = r?.[e.name] ?? (e.unqualifiedName != null ? r?.[e.unqualifiedName] : void 0) ?? "on"
```

So a nested skill listed as `<dir>:<name>` is matched on `<dir>:<name>` first and
`<name>` second. Absent at every layer = `"on"`.

**3. Plugin-sourced skills ignore `skillOverrides` entirely.**

```js
if (e.type !== "prompt" || e.source === "plugin") return "on";
```

This is the single most important constraint in this plan. A skill delivered by a
plugin **cannot** be individually turned off; the only lever is disabling the whole
plugin. The Skills tab must therefore render plugin skills as read-only, and say
why, or it will silently write overrides that do nothing.

**4. Related settings that are out of scope but worth knowing.**
`disableBundledSkills` (boolean) and `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` remove
Claude Code's own bundled skills wholesale. Not managed here.

**5. Claude Code already ships a `/skills` manager** with the same four states.
This tab is not a replacement for it. What `claude-optin` adds: per-skill token
estimates, the user/project/local source cascade shown explicitly, a repo-vs-global
write target, and one screen that sits alongside the Plugins and MCP tabs so you
can see where a session's context is actually going.

**6. Effective-state resolution is address-first across the merged cascade.**

The qualified lookup must search local, project, then user. Only when the qualified
address is absent from every layer may the resolver repeat that cascade for the
unqualified name. Checking an unqualified local key before a qualified project key
does not match Claude Code.

**7. Listing cost follows model visibility, not slash-command availability.**

| Effective state | Model listing | Slash command | Resident listing cost |
|---|---|---|---|
| `on` | name + description | available | full estimate |
| `name-only` | name only | available | name-only estimate |
| `user-invocable-only` | hidden | available | 0 |
| `off` | hidden | unavailable | 0 |

`disable-model-invocation: true` author-locks a skill to
`user-invocable-only` unless an explicit `off` override removes it entirely.
Plugin skills are forced to `on` whenever their plugin is effectively enabled.

**8. The tab is an active-session view, not a cache inventory.**

Uninstalled and effectively disabled plugins stay on the Plugins tab; their skills
do not appear on the Skills tab. Duplicate addresses collapse into one control so
expansion and toggling remain deterministic. Project metadata wins over personal
metadata for a personal/project collision, while every colliding path is retained
in the expanded detail. A plugin candidate wins a mixed collision and makes the row
read-only because an override cannot turn the whole address off.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/claude-optin/claude-optin` | modify | All production code. New: frontmatter parsing, active/scoped discovery and collision collapse, qualified-first settings resolution, `skill_display`, cycle/set/clear controls, and the third tab in `run()`. |
| `packages/claude-optin/test_claude_optin.py` | modify | New `SkillDiscoveryTests`, `SkillSettingsTests` classes; update `RowBuildingTests` for the Task 4 rename. |
| `packages/claude-optin/README.md` | modify | Document the tab, the four states, and the plugin-skill limitation. |
| `packages/claude-optin/manifest.json` | modify | Update `description` so the installer's package list reflects the new capability; flags and `example` stay unchanged. |
| `CHANGELOG.md`, `package.json` | modify | Version bump + entry (Task 7). |

No new files. The script is ~770 lines and grows by ~200; that is still within the
one-file convention used by every other package here.

---

### Task 1: Frontmatter map parser

`parse_frontmatter` returns only `(name, description)`. Skill entries also need
`disable-model-invocation`, which determines whether a skill costs any resident
tokens at all. Generalise the parser rather than adding a second bespoke reader.

**Files:**
- Modify: `packages/claude-optin/claude-optin:56-71` (replace `parse_frontmatter`)
- Test: `packages/claude-optin/test_claude_optin.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parse_frontmatter_map(path) -> dict[str, str]` — flat map of top-level
  frontmatter keys, including folded/literal continuation text for fields such as
  `description` and `when_to_use`. `parse_frontmatter(path) ->
  (name|None, description|None)` keeps its exact current signature and behaviour,
  reimplemented on top of the map.

- [ ] **Step 1: Write the failing test**

Add to `packages/claude-optin/test_claude_optin.py`, above `def load_doc`:

```python
class FrontmatterTests(unittest.TestCase):
    def _write(self, d, text):
        path = os.path.join(d, "SKILL.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def test_map_returns_all_top_level_keys(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write(d, "---\nname: alpha\n"
                                  "description: Does a thing\n"
                                  "disable-model-invocation: true\n---\nbody\n")
            fields = co.parse_frontmatter_map(path)
            self.assertEqual(fields["name"], "alpha")
            self.assertEqual(fields["description"], "Does a thing")
            self.assertEqual(fields["disable-model-invocation"], "true")

    def test_map_ignores_indented_continuation_lines(self):
        # Nested YAML must not leak into the top-level map.
        with tempfile.TemporaryDirectory() as d:
            path = self._write(d, "---\nname: beta\n"
                                  "metadata:\n  nested: value\n---\nbody\n")
            fields = co.parse_frontmatter_map(path)
            self.assertNotIn("nested", fields)
            self.assertEqual(fields["name"], "beta")

    def test_map_reads_folded_description_and_when_to_use(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write(d, "---\nname: beta\n"
                                  "description: >\n  Does a thing\n  safely\n"
                                  "when_to_use: Use during deploys\n---\n")
            fields = co.parse_frontmatter_map(path)
            self.assertEqual(fields["description"], "Does a thing safely")
            self.assertEqual(fields["when_to_use"], "Use during deploys")

    def test_map_is_empty_without_frontmatter(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write(d, "# Just a heading\n")
            self.assertEqual(co.parse_frontmatter_map(path), {})

    def test_map_is_empty_for_missing_file(self):
        self.assertEqual(co.parse_frontmatter_map("/nonexistent/SKILL.md"), {})

    def test_parse_frontmatter_still_returns_name_and_description(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write(d, "---\nname: gamma\ndescription: 'Quoted'\n---\n")
            self.assertEqual(co.parse_frontmatter(path), ("gamma", "Quoted"))

    def test_parse_frontmatter_returns_none_pair_without_frontmatter(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write(d, "no frontmatter\n")
            self.assertEqual(co.parse_frontmatter(path), (None, None))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py FrontmatterTests -v`
Expected: FAIL with `AttributeError: module 'claude_optin' has no attribute 'parse_frontmatter_map'`

- [ ] **Step 3: Write minimal implementation**

Replace lines 56-71 of `packages/claude-optin/claude-optin` with:

```python
def parse_frontmatter_map(path):
    """Return the top-level key -> value map from a markdown file's YAML
    frontmatter. This intentionally supports the scalar subset used by skill
    metadata: quoted/plain first-line values plus folded or literal blocks."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(8192)
    except OSError:
        return {}
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return {}
    fields, current, block_style, continuation = {}, None, None, []
    for line in m.group(1).splitlines():
        if line and not line[0].isspace() and ":" in line:
            if current and block_style:
                sep = " " if block_style == ">" else "\n"
                fields[current] = sep.join(continuation).strip()
            key, _, value = line.partition(":")
            current = key.strip()
            value = value.strip()
            block_style = value if value in (">", "|") else None
            continuation = []
            fields[current] = "" if block_style else value.strip("'\"")
            continue
        if current and block_style and line[:1].isspace():
            continuation.append(line.strip())
    if current and block_style:
        sep = " " if block_style == ">" else "\n"
        fields[current] = sep.join(continuation).strip()
    return fields


def parse_frontmatter(path):
    """Return (name, description) from a markdown file's YAML frontmatter."""
    fields = parse_frontmatter_map(path)
    return fields.get("name"), fields.get("description")
```

- [ ] **Step 4: Run the full suite to verify nothing regressed**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: PASS — all previous tests plus the six new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "refactor(claude-optin): generalise frontmatter parsing to a key map"
```

---

### Task 2: Skill discovery

Build the entry list the Skills tab renders. Three roots, one entry shape, sorted
by the address that `skillOverrides` is keyed on.

**Files:**
- Modify: `packages/claude-optin/claude-optin` — add after `discover_plugins` (line 173)
- Test: `packages/claude-optin/test_claude_optin.py`

**Interfaces:**
- Consumes: `parse_frontmatter_map` (Task 1); the plugin dicts returned by
  `discover_plugins()` — specifically `key`, `name`, `marketplace`, `version`.
- Produces: `discover_skills(repo_root, plugins, settings, claude_dir=None,
  cache_dir=None) -> list[dict]`.
  Each dict has: `kind="skill"`, `key` (== `address`), `name`, `address`, `source`
  (`"personal"` | `"project"` | `"plugin"`), `plugin_key` (str or `None`),
  `overridable` (bool), `path`, `desc`, `slash_only` (bool), `est_tokens`,
  `est_tokens_name_only`, `detail_items` (list of `(label, value)`), and
  `collision_paths` (list of strings). Only effectively enabled plugin skills are
  included. Duplicate addresses collapse to one row, sorted by `address.lower()`.

- [ ] **Step 1: Write the failing test**

Add to `packages/claude-optin/test_claude_optin.py`:

```python
def write_skill(root, name, desc="A skill", slash_only=False, nested=None):
    """Create <root>/[nested/]<name>/SKILL.md and return its directory."""
    parts = [root] + ([nested] if nested else []) + [name]
    d = os.path.join(*parts)
    os.makedirs(d, exist_ok=True)
    lines = ["---", f"name: {name}", f"description: {desc}"]
    if slash_only:
        lines.append("disable-model-invocation: true")
    lines += ["---", "body", ""]
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return d


class SkillDiscoveryTests(unittest.TestCase):
    class FakeSettings:
        def __init__(self, enabled=None):
            self.enabled = set(enabled or [])

        def effective(self, key, installed=True):
            return installed and key in self.enabled, "default"

    def test_finds_personal_and_project_skills_with_bare_addresses(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            repo = os.path.join(home, "repo")
            write_skill(os.path.join(claude_dir, "skills"), "alpha")
            write_skill(os.path.join(repo, ".claude", "skills"), "beta")
            skills = co.discover_skills(repo, [], self.FakeSettings(),
                                        claude_dir=claude_dir)
            by_addr = {s["address"]: s for s in skills}
            self.assertEqual(set(by_addr), {"alpha", "beta"})
            self.assertEqual(by_addr["alpha"]["source"], "personal")
            self.assertEqual(by_addr["beta"]["source"], "project")
            self.assertTrue(by_addr["alpha"]["overridable"])
            self.assertIsNone(by_addr["alpha"]["plugin_key"])

    def test_directory_scoped_project_skill_yields_qualified_address(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            repo = os.path.join(home, "repo")
            write_skill(os.path.join(repo, "group", ".claude", "skills"),
                        "inner")
            skills = co.discover_skills(repo, [],
                                        self.FakeSettings(),
                                        claude_dir=claude_dir)
            self.assertEqual([s["address"] for s in skills], ["group:inner"])

    def test_plugin_skills_are_prefixed_and_not_overridable(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            cache = os.path.join(claude_dir, "plugins", "cache")
            root = os.path.join(cache, "mkt", "myplug", "1.0.0", "skills")
            write_skill(root, "helper")
            co.CACHE_DIR = cache
            plugins = [{"key": "myplug@mkt", "name": "myplug",
                        "marketplace": "mkt", "version": "1.0.0"}]
            skills = co.discover_skills(
                os.path.join(home, "repo"), plugins,
                self.FakeSettings({"myplug@mkt"}), claude_dir=claude_dir,
                cache_dir=cache)
            self.assertEqual([s["address"] for s in skills], ["myplug:helper"])
            self.assertEqual(skills[0]["source"], "plugin")
            self.assertEqual(skills[0]["plugin_key"], "myplug@mkt")
            self.assertFalse(skills[0]["overridable"])

    def test_skips_disabled_and_uninstalled_plugin_skills(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            cache = os.path.join(claude_dir, "plugins", "cache")
            for name in ("disabled", "uninstalled"):
                write_skill(os.path.join(cache, "mkt", name, "1.0.0", "skills"),
                            "helper")
            plugins = [
                {"key": "disabled@mkt", "name": "disabled",
                 "marketplace": "mkt", "version": "1.0.0", "installed": True},
                {"key": "uninstalled@mkt", "name": "uninstalled",
                 "marketplace": "mkt", "version": "1.0.0", "installed": False},
            ]
            skills = co.discover_skills(
                os.path.join(home, "repo"), plugins, self.FakeSettings(),
                claude_dir=claude_dir, cache_dir=cache)
            self.assertEqual(skills, [])

    def test_duplicate_address_collapses_to_project_row_with_collision_details(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            repo = os.path.join(home, "repo")
            personal = write_skill(os.path.join(claude_dir, "skills"), "same",
                                   desc="personal")
            project = write_skill(os.path.join(repo, ".claude", "skills"), "same",
                                  desc="project")
            skills = co.discover_skills(repo, [], self.FakeSettings(),
                                        claude_dir=claude_dir)
            self.assertEqual(len(skills), 1)
            self.assertEqual(skills[0]["source"], "project")
            self.assertEqual(skills[0]["desc"], "project")
            self.assertEqual(set(skills[0]["collision_paths"]),
                             {os.path.join(personal, "SKILL.md"),
                              os.path.join(project, "SKILL.md")})

    def test_slash_only_skill_costs_no_resident_tokens(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            write_skill(os.path.join(claude_dir, "skills"), "quiet",
                        desc="x" * 400, slash_only=True)
            write_skill(os.path.join(claude_dir, "skills"), "loud",
                        desc="x" * 400)
            skills = {s["address"]: s
                      for s in co.discover_skills(os.path.join(home, "repo"),
                                                  [], self.FakeSettings(),
                                                  claude_dir=claude_dir)}
            self.assertTrue(skills["quiet"]["slash_only"])
            # Discovery stores raw listing estimates; skill_display applies
            # author/plugin locks to compute the effective cost.
            self.assertGreater(skills["quiet"]["est_tokens"], 90)
            self.assertGreater(skills["loud"]["est_tokens"], 90)
            # name-only keeps the name, drops the description
            self.assertLess(skills["loud"]["est_tokens_name_only"], 10)

    def test_directory_without_skill_md_is_skipped(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            os.makedirs(os.path.join(claude_dir, "skills", "empty"))
            skills = co.discover_skills(os.path.join(home, "repo"), [],
                                        self.FakeSettings(),
                                        claude_dir=claude_dir)
            self.assertEqual(skills, [])

    def test_missing_roots_return_empty_not_error(self):
        with tempfile.TemporaryDirectory() as home:
            skills = co.discover_skills(os.path.join(home, "repo"), [],
                                        self.FakeSettings(),
                                        claude_dir=os.path.join(home, "nope"))
            self.assertEqual(skills, [])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py SkillDiscoveryTests -v`
Expected: FAIL with `AttributeError: module 'claude_optin' has no attribute 'discover_skills'`

- [ ] **Step 3: Write minimal implementation**

Insert into `packages/claude-optin/claude-optin` immediately after `discover_plugins`
(after line 173, before `def _mcp_entry`):

```python
def _read_skill(skill_dir, address, source, plugin_key=None):
    """Build a skill entry from a skills/<name>/ directory, or None if the
    directory holds no SKILL.md."""
    path = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(path):
        return None
    fields = parse_frontmatter_map(path)
    desc = fields.get("description") or ""
    when_to_use = fields.get("when_to_use") or ""
    slash_only = fields.get("disable-model-invocation", "").lower() == "true"
    # The listing renders "- <address>: <desc>", or "- <address>" when the
    # override is name-only. Slash-only skills never reach the model listing.
    name_line = len(address) + 2
    full_text = " ".join(v for v in (address, desc, when_to_use) if v)
    est = len(full_text) // 4
    est_name_only = name_line // 4
    # Plugin skills ignore skillOverrides entirely (the CLI returns "on" for
    # any skill whose source is a plugin) -- the only lever is the plugin.
    overridable = source != "plugin"
    home = os.path.expanduser("~")
    return {
        "kind": "skill",
        "key": address,
        "name": os.path.basename(skill_dir),
        "address": address,
        "source": source,
        "plugin_key": plugin_key,
        "overridable": overridable,
        "path": path,
        "desc": desc,
        "when_to_use": when_to_use,
        "slash_only": slash_only,
        "est_tokens": est,
        "est_tokens_name_only": est_name_only,
        "collision_paths": [path],
        "detail_items": [
            ("desc", desc or "(no description)"),
            ("when", when_to_use or "(not specified)"),
            ("path", path.replace(home, "~")),
            ("cost", f"~{est} tok on, ~{est_name_only} tok as name-only"
                     + ("; author lock hides it from the model"
                        if slash_only else "")),
        ] + ([] if overridable else
             [("note", f"plugin skill - not overridable; "
                       f"disable {plugin_key} on the Plugins tab")]),
    }


def _scan_skill_root(root, source, plugin_key=None, prefix=""):
    """Scan one skills/<name>/SKILL.md root."""
    out = []
    if not os.path.isdir(root):
        return out
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return out
    for entry in entries:
        d = os.path.join(root, entry)
        if not os.path.isdir(d):
            continue
        skill = _read_skill(d, f"{prefix}{entry}", source, plugin_key)
        if skill:
            out.append(skill)
    return out


def _project_skill_roots(repo_root):
    """Yield root and directory-scoped project skill directories. Claude
    addresses <scope>/.claude/skills/<name> as <scope>:<name>."""
    out = []
    for current, dirs, _ in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in (".git", ".Codex", "node_modules")]
        if os.path.basename(current) != "skills" or \
                os.path.basename(os.path.dirname(current)) != ".claude":
            continue
        scope_root = os.path.dirname(os.path.dirname(current))
        scope = os.path.relpath(scope_root, repo_root)
        prefix = "" if scope == "." else f"{scope.replace(os.sep, '/')}:"
        out.append((current, prefix))
        dirs[:] = []
    return sorted(out)


def _collapse_skill_addresses(skills):
    """One safe control per override address; retain every colliding path."""
    grouped = {}
    for skill in skills:
        grouped.setdefault(skill["address"], []).append(skill)
    out = []
    for address, candidates in grouped.items():
        has_plugin = any(s["source"] == "plugin" for s in candidates)
        rank = ({"plugin": 0, "project": 1, "personal": 2} if has_plugin
                else {"project": 0, "personal": 1})
        candidates.sort(key=lambda s: (rank[s["source"]], s["path"]))
        winner = dict(candidates[0])
        paths = [s["path"] for s in candidates]
        winner["collision_paths"] = paths
        # If any candidate is plugin-backed, an override cannot turn the whole
        # address off, so the combined control must remain read-only.
        winner["overridable"] = all(s["source"] != "plugin" for s in candidates)
        if len(paths) > 1:
            winner["detail_items"] = list(winner["detail_items"]) + [
                ("collision", f"{len(paths)} skills share this address"),
                *[("also", p.replace(os.path.expanduser("~"), "~"))
                  for p in paths[1:]],
            ]
        out.append(winner)
    return sorted(out, key=lambda s: s["address"].lower())


def discover_skills(repo_root, plugins, settings, claude_dir=None,
                    cache_dir=None):
    """Every active personal, project/scoped-project, and plugin skill."""
    claude_dir = claude_dir or CLAUDE_DIR
    cache_dir = cache_dir or CACHE_DIR
    skills = _scan_skill_root(os.path.join(claude_dir, "skills"), "personal")
    for root, prefix in _project_skill_roots(repo_root):
        skills += _scan_skill_root(root, "project", prefix=prefix)
    for p in plugins:
        enabled, _ = settings.effective(p["key"], p.get("installed", True))
        if not p.get("version") or not enabled:
            continue
        root = os.path.join(cache_dir, p["marketplace"], p["name"],
                            p["version"], "skills")
        skills += _scan_skill_root(root, "plugin", plugin_key=p["key"],
                                   prefix=f"{p['name']}:")
    return _collapse_skill_addresses(skills)
```

- [ ] **Step 4: Run the full suite**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "feat(claude-optin): discover personal, project, and plugin skills"
```

---

### Task 3: Skill override resolution and cycling

**Files:**
- Modify: `packages/claude-optin/claude-optin` — add `_resolve_skill_map` next to
  `_resolve_mcp_map` (after line 267); extend `Settings.__init__` (lines 288-316),
  add methods after `cycle_mcp` (line 372), extend `save` (lines 374-383)
- Test: `packages/claude-optin/test_claude_optin.py`

**Interfaces:**
- Consumes: `Settings` as it exists today.
- Produces:
  - `_resolve_skill_map(doc) -> dict[str, str]` — normalised address → one of
    `"on"`, `"name-only"`, `"user-invocable-only"`, `"off"`.
  - `Settings.effective_skill(address, unqualified=None) -> (state, source)` where
    `state` is one of those four strings and `source` is `local|project|user|default`.
  - `Settings.cycle_skill(address, unqualified=None)` — advances the displayed
    effective state `on -> name-only -> off -> on`, writing an explicit value at
    the selected scope so every keypress changes the screen.
  - `Settings.set_skill(address, state)` — write an explicit state, or `None` to clear.
  - `Settings.clear_skill(address)` — remove only the write-target override.
  - `skill_display(skill, settings) -> dict` — the single tested source of truth
    for rendered state, source, editability, and resident token cost.

**Design note.** Space follows the state the user sees, not the raw value in the
write-target document. `O` and `U` write the two explicit rare states; `C` clears
the current scope so an inherited state becomes visible again. Author-locked and
plugin-locked behavior is normalized by `skill_display`, never reimplemented in
curses.

- [ ] **Step 1: Write the failing test**

Add to `packages/claude-optin/test_claude_optin.py`:

```python
class SkillSettingsTests(unittest.TestCase):
    def _settings(self, home, user=None, project=None, local=None,
                  global_mode=False):
        repo = os.path.join(home, "repo")
        os.makedirs(repo, exist_ok=True)
        if user is not None:
            write_json(os.path.join(home, ".claude", "settings.json"),
                       {"skillOverrides": user})
        if project is not None:
            write_json(os.path.join(repo, ".claude", "settings.json"),
                       {"skillOverrides": project})
        if local is not None:
            write_json(os.path.join(repo, ".claude", "settings.local.json"),
                       {"skillOverrides": local})
        co.CLAUDE_DIR = os.path.join(home, ".claude")
        return co.Settings(repo, global_mode=global_mode), repo

    def test_absent_everywhere_defaults_to_on(self):
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home)
            self.assertEqual(s.effective_skill("alpha"), ("on", "default"))

    def test_local_beats_project_beats_user(self):
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home, user={"a": "off"},
                                  project={"a": "name-only"},
                                  local={"a": "on"})
            self.assertEqual(s.effective_skill("a"), ("on", "local"))
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home, user={"a": "off"},
                                  project={"a": "name-only"})
            self.assertEqual(s.effective_skill("a"), ("name-only", "project"))

    def test_qualified_address_wins_over_unqualified(self):
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home, user={"grp:a": "off", "a": "name-only"})
            self.assertEqual(s.effective_skill("grp:a", unqualified="a"),
                             ("off", "user"))

    def test_qualified_project_beats_unqualified_local(self):
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home, project={"grp:a": "on"},
                                  local={"a": "off"})
            self.assertEqual(s.effective_skill("grp:a", unqualified="a"),
                             ("on", "project"))

    def test_unqualified_fallback_is_used_when_qualified_absent(self):
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home, user={"a": "off"})
            self.assertEqual(s.effective_skill("grp:a", unqualified="a"),
                             ("off", "user"))

    def test_unknown_value_is_treated_as_on(self):
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home, user={"a": "bogus"})
            self.assertEqual(s.effective_skill("a"), ("on", "user"))

    def test_cycle_follows_effective_state_and_writes_explicit_on(self):
        with tempfile.TemporaryDirectory() as home:
            s, repo = self._settings(home)
            path = os.path.join(repo, ".claude", "settings.local.json")
            s.cycle_skill("a")
            self.assertEqual(load_doc(path)["skillOverrides"], {"a": "name-only"})
            self.assertEqual(s.effective_skill("a"), ("name-only", "local"))
            s.cycle_skill("a")
            self.assertEqual(load_doc(path)["skillOverrides"], {"a": "off"})
            s.cycle_skill("a")
            self.assertEqual(load_doc(path)["skillOverrides"], {"a": "on"})
            self.assertEqual(s.effective_skill("a"), ("on", "local"))

    def test_clear_removes_only_write_target_override(self):
        with tempfile.TemporaryDirectory() as home:
            s, repo = self._settings(home, user={"a": "off"}, local={"a": "on"})
            path = os.path.join(repo, ".claude", "settings.local.json")
            s.clear_skill("a")
            self.assertNotIn("skillOverrides", load_doc(path))
            self.assertEqual(s.effective_skill("a"), ("off", "user"))

    def test_cycle_from_an_explicitly_set_rare_state_advances(self):
        # O/U write "on"/"user-invocable-only"; space must then advance to
        # name-only, not silently clear the override.
        with tempfile.TemporaryDirectory() as home:
            s, repo = self._settings(home)
            path = os.path.join(repo, ".claude", "settings.local.json")
            s.set_skill("a", "user-invocable-only")
            s.cycle_skill("a")
            self.assertEqual(load_doc(path)["skillOverrides"], {"a": "name-only"})
            s.set_skill("a", "on")
            s.cycle_skill("a")
            self.assertEqual(load_doc(path)["skillOverrides"], {"a": "name-only"})

    def test_set_skill_writes_explicit_state_and_clears_on_none(self):
        with tempfile.TemporaryDirectory() as home:
            s, repo = self._settings(home)
            path = os.path.join(repo, ".claude", "settings.local.json")
            s.set_skill("a", "user-invocable-only")
            self.assertEqual(load_doc(path)["skillOverrides"],
                             {"a": "user-invocable-only"})
            s.set_skill("a", None)
            self.assertNotIn("skillOverrides", load_doc(path))

    def test_global_mode_writes_user_settings(self):
        with tempfile.TemporaryDirectory() as home:
            s, _ = self._settings(home, global_mode=True)
            s.cycle_skill("a")
            doc = load_doc(os.path.join(home, ".claude", "settings.json"))
            self.assertEqual(doc["skillOverrides"], {"a": "name-only"})
            self.assertEqual(s.effective_skill("a"), ("name-only", "user"))


class SkillDisplayTests(unittest.TestCase):
    class FakeSettings:
        def __init__(self, state="on", source="default"):
            self.value = state, source

        def effective_skill(self, address, unqualified=None):
            return self.value

    def _skill(self, **overrides):
        skill = {"address": "alpha", "name": "alpha", "overridable": True,
                 "source": "personal", "slash_only": False,
                 "est_tokens": 100, "est_tokens_name_only": 3}
        skill.update(overrides)
        return skill

    def test_user_invocable_only_and_off_cost_zero(self):
        for state in ("user-invocable-only", "off"):
            display = co.skill_display(self._skill(), self.FakeSettings(state))
            self.assertEqual(display["tokens"], 0)

    def test_plugin_skill_ignores_inert_override(self):
        display = co.skill_display(
            self._skill(source="plugin", overridable=False),
            self.FakeSettings("off", "local"))
        self.assertEqual(display["state"], "on")
        self.assertEqual(display["source"], "plugin")
        self.assertEqual(display["tokens"], 100)
        self.assertFalse(display["editable"])
        self.assertTrue(display["inert_override"])

    def test_plugin_lock_wins_over_author_lock(self):
        display = co.skill_display(
            self._skill(source="plugin", overridable=False, slash_only=True),
            self.FakeSettings("on"))
        self.assertEqual(display["state"], "on")
        self.assertEqual(display["tokens"], 100)

    def test_author_locked_skill_is_user_only_unless_off(self):
        display = co.skill_display(self._skill(slash_only=True),
                                   self.FakeSettings("on"))
        self.assertEqual(display["state"], "user-invocable-only")
        self.assertEqual(display["tokens"], 0)
        display = co.skill_display(self._skill(slash_only=True),
                                   self.FakeSettings("off", "user"))
        self.assertEqual(display["state"], "off")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py SkillSettingsTests -v`
Expected: FAIL with `AttributeError: 'Settings' object has no attribute 'effective_skill'`

- [ ] **Step 3: Write minimal implementation**

**3a.** Insert after `_resolve_mcp_map` (after line 267) in `packages/claude-optin/claude-optin`:

```python
SKILL_STATES = ("on", "name-only", "user-invocable-only", "off")

# space-key cycle follows effective state; clearing is the explicit C key.
_CYCLE_NEXT = {None: "name-only", "name-only": "off", "off": "on",
               "on": "name-only", "user-invocable-only": "name-only"}


def _resolve_skill_map(doc):
    """Collapse a settings doc's skillOverrides into address -> state.
    Values are strings from SKILL_STATES; anything unrecognised reads as
    "on", matching the CLI's absent-or-invalid default."""
    out = {}
    for name, value in (doc.get("skillOverrides") or {}).items():
        state = str(value).lower()
        out[name] = state if state in SKILL_STATES else "on"
    return out
```

**3b.** In `Settings.__init__`, after the three `*_mcp` assignments (line 316), add:

```python
        # Per-skill listing overrides, same three-layer cascade.
        self.user_skills = _resolve_skill_map(self.user_doc)
        self.project_skills = _resolve_skill_map(project_doc)
        self.local_skills = _resolve_skill_map(self.local_doc)
```

**3c.** Insert after `cycle_mcp` (after line 372):

```python
    def effective_skill(self, address, unqualified=None):
        """Resolve qualified address across all layers before falling back to
        the unqualified name, matching Claude Code's merged-map lookup."""
        layers = ((self.local_skills, "local"),
                  (self.project_skills, "project"),
                  (self.user_skills, "user"))
        for name in (address, unqualified):
            if not name:
                continue
            for mapping, layer in layers:
                if name in mapping:
                    return mapping[name], layer
        return "on", "default"

    def _write_skill(self, address, state):
        ov = self.write_doc.setdefault("skillOverrides", {})
        if state is None:
            ov.pop(address, None)
        else:
            ov[address] = state
        refreshed = _resolve_skill_map(self.write_doc)
        if self.global_mode:
            self.user_skills = refreshed
        else:
            self.local_skills = refreshed
        self.save()

    def cycle_skill(self, address, unqualified=None):
        """on -> name-only -> off -> on using the displayed effective state."""
        current, _ = self.effective_skill(address, unqualified)
        self._write_skill(address, _CYCLE_NEXT[current])

    def set_skill(self, address, state):
        """Write an explicit state, or None to clear the override."""
        if state is not None and state not in SKILL_STATES:
            raise ValueError(f"unknown skill state: {state}")
        self._write_skill(address, state)

    def clear_skill(self, address):
        """Remove only the write-target layer's override."""
        self._write_skill(address, None)


def skill_display(skill, settings):
    """Return the truthful row model consumed by rendering and totals."""
    state, source = settings.effective_skill(skill["address"], skill["name"])
    editable = skill["overridable"]
    inert_override = False
    if not editable:
        inert_override = source != "default"
        state, source = "on", "plugin"
    elif skill["slash_only"] and state != "off":
        state = "user-invocable-only"
        if source == "default":
            source = "author"
    tokens = {
        "on": skill["est_tokens"],
        "name-only": skill["est_tokens_name_only"],
        "user-invocable-only": 0,
        "off": 0,
    }[state]
    return {"state": state, "source": source, "tokens": tokens,
            "editable": editable, "inert_override": inert_override}
```

**3d.** In `save` (line 377), add `"skillOverrides"` to the prune tuple:

```python
        for empty_key in ("enabledPlugins", "enabledMcpjsonServers",
                          "disabledMcpjsonServers", "skillOverrides"):
```

- [ ] **Step 4: Run the full suite**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "feat(claude-optin): resolve and cycle skillOverrides across scopes"
```

---

### Task 4: Rename plugin child row kinds

`build_rows` already emits `("skill", ...)` for the child rows under an expanded
plugin. Task 5 introduces top-level entries whose `kind` is also `"skill"`, and the
renderer branches on `kind`. Rename the child tags first so the collision never
exists.

**Files:**
- Modify: `packages/claude-optin/claude-optin:396-404` (`build_rows`), `:632-637`
  (renderer `else` branch)
- Test: `packages/claude-optin/test_claude_optin.py:202-217` (`RowBuildingTests`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `build_rows` emits child kinds `"child-skill"`, `"child-agent"`,
  `"child-other"` instead of `"skill"`, `"agent"`, `"other"`. `"empty"` and
  `"mcp-detail"` are unchanged. Top-level kinds `"plugin"` and `"mcp"` unchanged.

- [ ] **Step 1: Write the failing test**

Add to `RowBuildingTests` in `packages/claude-optin/test_claude_optin.py`:

```python
    def test_expanded_plugin_children_use_child_prefixed_kinds(self):
        # Child rows must not collide with the top-level "skill" entry kind
        # used by the Skills tab; the renderer branches on kind.
        p = self._plugin("P1")
        p["skills"] = [("s1", "desc one")]
        p["agents"] = [("a1", "desc two")]
        p["other_items"] = [("hooks/h.sh", "")]
        rows = co.build_rows([p], {p["key"]})
        self.assertEqual([r[0] for r in rows],
                         ["plugin", "child-skill", "child-agent", "child-other"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py RowBuildingTests -v`
Expected: FAIL — `Lists differ: ['plugin', 'skill', 'agent', 'other'] != ['plugin', 'child-skill', 'child-agent', 'child-other']`

- [ ] **Step 3: Write minimal implementation**

In `build_rows` (lines 396-404), change the three child appends:

```python
        if e["kind"] == "plugin":
            for s, desc in e["skills"]:
                rows.append(("child-skill", i, f"{s}  {desc}"))
            for a, desc in e["agents"]:
                rows.append(("child-agent", i, f"{a}  {desc}"))
            for path, desc in e["other_items"]:
                rows.append(("child-other", i, f"{path}  {desc}".rstrip()))
```

In the renderer's final `else` branch (lines 632-637), update the tag map and the
colour lookup:

```python
            else:
                tag = {"child-skill": "skill", "child-agent": "agent",
                       "child-other": "other", "empty": "",
                       "mcp-detail": "·"}[kind]
                color = (CYAN if kind == "child-agent"
                         else YELLOW if kind == "child-other" else 0)
                stdscr.addnstr(y, 11, f"· {tag:<5} {text}", w - 12,
                               color | attr | curses.A_DIM)
```

- [ ] **Step 4: Run the full suite**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: PASS

- [ ] **Step 5: Manually verify the Plugins tab still renders children**

Run: `python3 packages/claude-optin/claude-optin`
Press `l` on a plugin with skills and agents. Expected: child rows still show
`· skill  <name>  <desc>` and `· agent  …` in cyan, exactly as before. Press `q`.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "refactor(claude-optin): namespace plugin child row kinds"
```

---

### Task 5: Skills tab in the TUI

**Files:**
- Modify: `packages/claude-optin/claude-optin` — `build_rows` (line 388),
  `run()` signature and body (lines 413-735), `main()` (lines 738-762)
- Test: `packages/claude-optin/test_claude_optin.py`

**Interfaces:**
- Consumes: `discover_skills` (Task 2), `Settings.effective_skill` /
  `cycle_skill` / `set_skill` (Task 3), the `child-*` row kinds (Task 4).
- Produces: `run(stdscr, plugins, servers, skills, settings)` — note the new
  fourth positional argument, before `settings`. `build_rows` gains a `"skill"`
  branch emitting `("skill-detail", i, text)` sub-rows.

- [ ] **Step 1: Write the failing test**

Add to `RowBuildingTests` in `packages/claude-optin/test_claude_optin.py`:

```python
    def _skill(self, address):
        return {"kind": "skill", "key": address, "name": address,
                "address": address, "source": "personal", "plugin_key": None,
                "overridable": True, "path": "/x/SKILL.md", "desc": "d",
                "slash_only": False, "est_tokens": 10,
                "est_tokens_name_only": 2,
                "detail_items": [("desc", "d"), ("path", "/x/SKILL.md")]}

    def test_expanded_skill_shows_detail_rows(self):
        s = self._skill("alpha")
        rows = co.build_rows([s], {s["key"]})
        self.assertEqual([r[0] for r in rows],
                         ["skill", "skill-detail", "skill-detail"])

    def test_collapsed_skill_is_a_single_row(self):
        s = self._skill("alpha")
        self.assertEqual([r[0] for r in co.build_rows([s], set())], ["skill"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py RowBuildingTests -v`
Expected: FAIL — `KeyError: 'skill'` or a rows list of `["skill"]` only, because
`build_rows` has no `skill` branch.

- [ ] **Step 3: Add the `build_rows` branch**

In `build_rows`, replace the `else:   # mcp` branch (lines 405-409) with:

```python
        elif e["kind"] == "mcp":
            for label, val in e["detail_items"]:
                rows.append(("mcp-detail", i, f"{label}  {val}"))
            if not e["detail_items"]:
                rows.append(("empty", i, "(no connection details)"))
        else:   # skill
            for label, val in e["detail_items"]:
                rows.append(("skill-detail", i, f"{label}  {val}"))
```

- [ ] **Step 4: Run the row tests to verify they pass**

Run: `python3 packages/claude-optin/test_claude_optin.py RowBuildingTests -v`
Expected: PASS

- [ ] **Step 5: Wire the third tab into `run()`**

**5a.** Change the signature (line 413):

```python
def run(stdscr, plugins, servers, skills, settings):
```

**5b.** Replace the tab constants (lines 436-437):

```python
    tab = 0           # 0 = Plugins, 1 = MCP Servers, 2 = Skills
    TAB_NAMES = ["Plugins", "MCP Servers", "Skills"]
```

**5c.** After the `srv` sort block (line 478), add the skill sort and extend the
display selection (line 479):

First add `"author": 3` to `SRC_ORDER` and move `"default"` to `4`, so
author-locked slash-only skills sort and render as a real source rather than as a
default setting.

```python
        # Skills support name/enabled/source/tokens; other modes keep the
        # default address ordering.
        def _skill_state(s):
            return skill_display(s, settings)
        if sort_mode == "enabled":
            skl = sorted(skills, key=lambda s: (0 if _skill_state(s)["state"] == "on"
                                                else 1, s["address"].lower()))
        elif sort_mode == "source":
            # Plugin skills have no editable source; group them last.
            skl = sorted(skills, key=lambda s: (
                5 if not s["overridable"]
                else SRC_ORDER.get(_skill_state(s)["source"], 4),
                s["address"].lower()))
        elif sort_mode == "tokens":
            skl = sorted(skills, key=lambda s: -_skill_state(s)["tokens"])
        elif sort_mode == "name":
            skl = sorted(skills, key=lambda s: s["address"].lower())
        else:
            skl = skills
        display = [plug, srv, skl][tab]
        display = list(display)
```

**5d.** Add the skill row renderer.

> **Placement is load-bearing.** The renderer dispatches
> `if kind == "plugin"` → `elif kind == "mcp"` → `else`, and Task 4 turned that
> final `else` into a dict lookup that has no `"skill"` key. Insert this new
> `elif` **after the `elif kind == "mcp":` block ends (after line 631) and
> before the final `else:`**. Put it after the `else` and every skill row
> raises `KeyError: 'skill'`. Do not add `"skill"` to Task 4's tag dict —
> `"skill"` is a top-level entry kind, `"skill-detail"` is the sub-row.

Insert:

```python
            elif kind == "skill":
                sk = display[pi]
                model = skill_display(sk, settings)
                state, src, cost = (model["state"], model["source"],
                                    model["tokens"])
                if not model["editable"]:
                    mark, color, src_tag = "?", YELLOW, "plugin  "
                else:
                    mark, color = {
                        "on": ("✓", GREEN),
                        "name-only": ("~", YELLOW),
                        "user-invocable-only": ("/", YELLOW),
                        "off": ("✗", RED),
                    }[state]
                    src_tag = {"local": "local   ", "project": "project ",
                               "user": "user    ", "author": "author  "}.get(
                                   src, "default ")
                arrow = "▾" if sk["key"] in expanded else "▸"
                warning = "  ! inert override" if model["inert_override"] else ""
                name_str = f"{arrow} {sk['address']}{warning}"
                info_segs = [
                    ("[ ", True), (f"{state:<19}", False),
                    (" ~", True), (f"{cost:>4}", False), (" tok ]", True),
                ]
                info_str = "".join(seg for seg, _ in info_segs)
                if not model["editable"] or sk["slash_only"]:
                    name_color = DIM_WHITE | curses.A_DIM
                elif state == "off":
                    name_color = RED
                elif state == "on":
                    name_color = GREEN
                else:
                    name_color = YELLOW
                stdscr.addnstr(y, 0, " ", 1, attr)
                stdscr.addnstr(y, 1, mark, 1, color | attr | curses.A_BOLD)
                editable = "user" if settings.global_mode else "local"
                stdscr.addnstr(y, 2, f" {src_tag}", 9,
                               (YELLOW if src == editable else curses.A_DIM) | attr)
                info_col = w - len(info_str) - 1
                if info_col > 11:
                    stdscr.addnstr(y, 11, name_str, max(1, info_col - 12),
                                   name_color | attr)
                    ix = info_col
                    for seg, is_label in info_segs:
                        if ix >= w - 1:
                            break
                        n = min(len(seg), w - 1 - ix)
                        stdscr.addnstr(y, ix, seg, n,
                                       (curses.A_DIM if is_label else 0) | attr)
                        ix += len(seg)
                else:
                    stdscr.addnstr(y, 11, name_str, max(1, w - 12),
                                   name_color | attr)
```

**5e.** Add `"skill-detail"` to the final `else` branch's tag map (Task 4's version):

```python
                tag = {"child-skill": "skill", "child-agent": "agent",
                       "child-other": "other", "empty": "",
                       "mcp-detail": "·", "skill-detail": "·"}[kind]
```

**5f.** Extend the toggle handler (lines 711-719) with a skill case, and add the
two explicit-state keys after the `D` handler (line 733):

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
            elif entry["kind"] == "skill":
                if entry["overridable"]:
                    settings.cycle_skill(entry["address"], entry["name"])
                    notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
                else:
                    notify_msg, notify_color, notify_at = \
                        "plugin skill - toggle the plugin", NOTIFY_DELETED, time.time()
        elif ch in (ord("O"), ord("U")) and entry \
                and entry["kind"] == "skill" and entry["overridable"]:
            settings.set_skill(entry["address"],
                               "on" if ch == ord("O") else "user-invocable-only")
            notify_msg, notify_color, notify_at = "saved", NOTIFY_SAVED, time.time()
        elif ch == ord("C") and entry and entry["kind"] == "skill" \
                and entry["overridable"]:
            settings.clear_skill(entry["address"])
            notify_msg, notify_color, notify_at = "cleared", NOTIFY_SAVED, time.time()
```

**5g.** Extend the header info line (lines 496-505) so the skill totals are visible
from any tab. Replace the `enabled_tok` computation (lines 490-491) and append to
`info_segs`:

```python
        enabled_tok = sum(p["est_tokens"] for p in plugins
                          if settings.effective(p["key"], p["installed"])[0])
        skill_tok = 0
        for sk in skills:
            skill_tok += skill_display(sk, settings)["tokens"]
```

and add these two segments to the end of `info_segs`:

```python
            (" · active skill listing ", True), (f"{len(skills)}", False),
            (" ≈", True), (f"{skill_tok} tok", False),
```

**5h.** Extend the footer (lines 647-659) so the new keys are discoverable. After
the `if tab == 0:` delete-key block, add:

```python
            if tab == 2:   # skills-only explicit states
                footer_segs += [("O", True), (":on  ", False),
                                ("U", True), (":user-only  ", False),
                                ("C", True), (":clear-scope  ", False)]
```

**5i.** Update `main()` (lines 750-760):

```python
    plugins = discover_plugins()
    repo_root = find_repo_root()
    settings = Settings(repo_root, global_mode=args.global_mode)

    servers = discover_mcp_servers(os.getcwd())
    referenced = set(settings.local_mcp) | set(settings.project_mcp) \
        | set(settings.user_mcp)
    servers = add_orphans(servers, referenced)

    skills = discover_skills(repo_root, plugins, settings)

    if not plugins and not servers and not skills:
        sys.exit(f"No plugins found in {CACHE_DIR}, no MCP servers, no skills")
    curses.wrapper(run, plugins, servers, skills, settings)
```

- [ ] **Step 6: Run the full suite**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: PASS

- [ ] **Step 7: Manually verify the tab**

Run: `python3 packages/claude-optin/claude-optin`

Check each of these, since curses rendering is not unit-tested:

1. `tab` twice reaches **Skills**; the tab bar underlines it.
2. Personal skills show `default` source and a `✓ on` state.
3. A plugin skill (address `<plugin>:<name>`) shows `?` with source tag `plugin`,
   dimmed. Pressing `space` on it flashes `plugin skill - toggle the plugin`
   and writes nothing.
4. `space` on a personal skill cycles `on → name-only → off → on`, the token
   column drops accordingly, and a `saved` badge appears.
5. `user-invocable-only` and `off` both show zero listing tokens.
6. `O` and `U` set `on` and `user-invocable-only`; `C` clears only the selected
   scope and reveals the inherited state.
7. An inherited unqualified override is shown for a nested skill unless a qualified
   override exists at any layer.
8. Disabled and uninstalled plugin skills do not appear. An enabled plugin skill
   always shows forced `on`; an existing ignored override adds `! inert override`
   to the row without changing its state or cost.
9. `l` expands a skill to `· desc`, `· when`, `· path`, `· cost`, and
   any collision rows.
10. `s` cycles sort; `tokens` uses effective rather than maximum cost.
11. `q` exits and prints the write path.

Then confirm the file on disk:

```bash
python3 -c "import json;print(json.load(open('.claude/settings.local.json')).get('skillOverrides'))"
```

Expected: the addresses you toggled, with their states. Revert any test toggles
before committing.

- [ ] **Step 8: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "feat(claude-optin): add Skills tab with per-skill listing overrides"
```

---

### Task 6: Guard against writing overrides that do nothing

Task 5 blocks the toggle in the UI, but a `skillOverrides` entry for a plugin skill
could already exist in someone's settings from a hand-edit — and it silently does
nothing. Surface it rather than leaving the user to wonder.

**Files:**
- Modify: `packages/claude-optin/claude-optin` — `discover_skills`
- Test: `packages/claude-optin/test_claude_optin.py`

**Interfaces:**
- Consumes: `discover_skills` (Task 2), `Settings` (Task 3).
- Produces: `inert_skill_overrides(skills, settings) -> list[str]` — addresses that
  have an override somewhere in the cascade but belong to a plugin, so the override
  has no effect.

- [ ] **Step 1: Write the failing test**

```python
class InertOverrideTests(unittest.TestCase):
    def test_plugin_skill_overrides_are_reported_as_inert(self):
        with tempfile.TemporaryDirectory() as home:
            claude_dir = os.path.join(home, ".claude")
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            cache = os.path.join(claude_dir, "plugins", "cache")
            write_skill(os.path.join(cache, "mkt", "myplug", "1.0.0", "skills"),
                        "helper")
            write_skill(os.path.join(claude_dir, "skills"), "mine")
            write_json(os.path.join(claude_dir, "settings.json"),
                       {"skillOverrides": {"myplug:helper": "off",
                                           "mine": "off"}})
            co.CLAUDE_DIR = claude_dir
            co.CACHE_DIR = cache
            plugins = [{"key": "myplug@mkt", "name": "myplug",
                        "marketplace": "mkt", "version": "1.0.0",
                        "installed": True}]
            settings = co.Settings(repo, global_mode=True)
            skills = co.discover_skills(repo, plugins, settings,
                                        claude_dir=claude_dir,
                                        cache_dir=cache)
            self.assertEqual(co.inert_skill_overrides(skills, settings),
                             ["myplug:helper"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 packages/claude-optin/test_claude_optin.py InertOverrideTests -v`
Expected: FAIL with `AttributeError: module 'claude_optin' has no attribute 'inert_skill_overrides'`

- [ ] **Step 3: Write minimal implementation**

Add after `discover_skills` in `packages/claude-optin/claude-optin`:

```python
def inert_skill_overrides(skills, settings):
    """Addresses with a skillOverrides entry that the CLI ignores, because
    the skill comes from a plugin. Sorted, for a startup warning."""
    out = []
    for s in skills:
        if s["overridable"]:
            continue
        _, src = settings.effective_skill(s["address"])
        if src != "default":
            out.append(s["address"])
    return sorted(out)
```

- [ ] **Step 4: Surface it at exit**

In `main()`, after `curses.wrapper(...)` and before the existing two `print` calls:

```python
    inert = inert_skill_overrides(skills, settings)
    if inert:
        print(f"Note: {len(inert)} skillOverrides entr"
              f"{'y has' if len(inert) == 1 else 'ies have'} no effect — "
              "plugin skills ignore skillOverrides. Disable the plugin instead:")
        for address in inert:
            print(f"  {address}")
```

- [ ] **Step 5: Run the full suite**

Run: `python3 packages/claude-optin/test_claude_optin.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/test_claude_optin.py
git commit -m "feat(claude-optin): warn about skillOverrides that plugins ignore"
```

---

### Task 7: Documentation, manifest, changelog

**Files:**
- Modify: `packages/claude-optin/claude-optin:1-28` (module docstring)
- Modify: `packages/claude-optin/README.md`
- Modify: `packages/claude-optin/manifest.json`
- Modify: `CHANGELOG.md`, `package.json`

**Interfaces:**
- Consumes: the finished feature.
- Produces: no code.

- [ ] **Step 1: Update the module docstring**

In `packages/claude-optin/claude-optin`, extend the bullet list (lines 7-13) with a
third entry and the key list (lines 15-22) with the two new keys:

```
  • Skills — every skill that can appear in a session's skill listing:
    personal (~/.claude/skills), project (<repo>/.claude/skills), and one
    per installed plugin. Toggling writes skillOverrides, whose four states
    are on / name-only / user-invocable-only / off. "name-only" keeps the
    skill usable but drops its description from the listing, which is where
    almost all of a skill's resident cost lives.

    Plugin skills are shown read-only: the CLI ignores skillOverrides for
    anything a plugin delivers, so the only lever is the plugin itself.
```

and, in the Keys block:

```
  O             skills tab: set "on"      U    set "user-invocable-only"
  C             skills tab: clear the current write-scope override
```

- [ ] **Step 2: Update the README**

Add a `## Skills tab` section to `packages/claude-optin/README.md` covering: the
three sources and how each is addressed, the four states with the one-line meaning
of each, why `name-only` is usually the right first move, the plugin-skill
limitation, active-plugin filtering, duplicate-address collapse, and the `O` / `U`
/ `C` keys. State explicitly that `user-invocable-only` and `off` both cost zero
resident listing tokens. Explain that the skill-listing estimate overlaps the
Plugins-tab estimate for plugin-delivered skills and must not be added to it as an
overall total. Mirror the structure of the existing MCP section.

- [ ] **Step 3: Update the manifest description**

In `packages/claude-optin/manifest.json`, replace `description` with text that names
all three tabs, and leave `example` as-is (the flags did not change).

- [ ] **Step 4: Verify the installed copy would pick this up**

Run: `python3 -c "import json;m=json.load(open('packages/claude-optin/manifest.json'));print(m['files'],m['destDir'])"`
Expected: `['claude-optin'] ~/.local/bin` — confirming a single-file install, so
`npm run install-packages` is all that's needed to deploy.

- [ ] **Step 5: Bump the version and write the changelog**

Per repo `CLAUDE.md`: bump the `version` patch in `package.json`, then add a
`## v<new> - <YYYY-MM-DD>` entry to `CHANGELOG.md` summarising the Skills tab, the
four override states, and the plugin-skill limitation.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-optin/claude-optin packages/claude-optin/README.md \
        packages/claude-optin/manifest.json CHANGELOG.md package.json
git commit -m "docs(claude-optin): document the Skills tab"
```

- [ ] **Step 7: Offer the reinstall**

Repo `CLAUDE.md` requires asking after `packages/` changes land: ask the user
whether to run `npm run install-packages`.

---

## Self-review

**Spec coverage.** The request was "support individual skills not just plugins."
Task 2 produces one active control per address and excludes inactive plugin cache
entries. Task 3 resolves qualified/unqualified settings in Claude's order and owns
the tested state/source/cost truth table. Task 5 renders that model and exposes
predictable cycle/set/clear controls. Tasks 1/4 are enabling refactors, Task 6
surfaces settings Claude ignores, and Task 7 documents the exact behavior.

**Type consistency.** `address` is the override key everywhere: produced by
`_read_skill`, sorted on in `discover_skills`, passed to `effective_skill` /
`cycle_skill` / `set_skill` / `clear_skill`, and rendered as `name_str`. `name` is
always passed as the unqualified fallback. `state` is always one of
the four `SKILL_STATES` strings — never a boolean, unlike `effective()` for plugins.
All curses state and cost values come from `skill_display`; the header and row cannot
drift independently.
`run()` gains `skills` as its fourth positional argument, and `main()` and the
`curses.wrapper` call are both updated in Task 5 Step 5.

**Known limitations, deliberately not addressed.**

- Bundled Claude Code skills are not discovered — they live inside the binary, not
  on disk. `disableBundledSkills` is the lever for those and is out of scope.
- Token figures are `chars/4` estimates over name, description, and `when_to_use`,
  consistent with the existing package's estimates. They will not match `/context`
  exactly.
- Address collisions collapse to a single safe control. Project metadata is shown
  first and all paths remain inspectable; the tool does not attempt to explain
  Claude Code's internal load-order diagnostics beyond that.
