#!/usr/bin/env python3
"""Tests for claude-optin's pure logic (MCP discovery + settings).

The TUI/curses parts aren't exercised here — only the data layer:
MCP server discovery (the .mcp.json walk + orphan detection) and the
Settings class's MCP enable/disable resolution and cycling.

Run: python3 packages/claude-optin/test_claude_optin.py
"""

import importlib.util
import json
import os
import tempfile
import unittest
from importlib.machinery import SourceFileLoader


def load_module():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "claude-optin")
    loader = SourceFileLoader("claude_optin", path)
    spec = importlib.util.spec_from_loader("claude_optin", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


co = load_module()


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def write_file(path, contents):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(contents)


class McpDiscoveryTests(unittest.TestCase):
    def test_walks_up_to_home_collecting_mcp_json(self):
        with tempfile.TemporaryDirectory() as home:
            # ~/workspace/.mcp.json defines two servers
            write_json(os.path.join(home, "workspace", ".mcp.json"),
                       {"mcpServers": {
                           "Alpha": {"type": "http", "url": "https://a"},
                           "Beta": {"command": "node", "args": ["b.js"]},
                       }})
            repo = os.path.join(home, "workspace", "myrepo")
            os.makedirs(repo)
            servers = co.discover_mcp_servers(repo, home=home,
                                              user_json_path="/nonexistent")
            by_name = {s["name"]: s for s in servers}
            self.assertEqual(set(by_name), {"Alpha", "Beta"})
            self.assertEqual(by_name["Alpha"]["transport"], "http")
            self.assertEqual(by_name["Beta"]["transport"], "stdio")
            self.assertFalse(by_name["Alpha"]["orphan"])
            self.assertEqual(by_name["Alpha"]["kind"], "mcp")

    def test_nearer_mcp_json_wins_on_collision(self):
        with tempfile.TemporaryDirectory() as home:
            write_json(os.path.join(home, ".mcp.json"),
                       {"mcpServers": {"Dup": {"type": "http", "url": "far"}}})
            repo = os.path.join(home, "a", "b")
            os.makedirs(repo)
            write_json(os.path.join(repo, ".mcp.json"),
                       {"mcpServers": {"Dup": {"type": "http", "url": "near"}}})
            servers = co.discover_mcp_servers(repo, home=home,
                                              user_json_path="/nonexistent")
            dup = next(s for s in servers if s["name"] == "Dup")
            self.assertEqual(dup["definition"]["url"], "near")

    def test_merges_user_scope_from_claude_json(self):
        with tempfile.TemporaryDirectory() as home:
            user_json = os.path.join(home, ".claude.json")
            write_json(user_json,
                       {"mcpServers": {"UserScoped": {"type": "http",
                                                      "url": "https://u"}}})
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            servers = co.discover_mcp_servers(repo, home=home,
                                              user_json_path=user_json)
            us = next(s for s in servers if s["name"] == "UserScoped")
            self.assertEqual(us["source"], "user")

    def test_orphans_appended_for_unknown_listed_names(self):
        with tempfile.TemporaryDirectory() as home:
            write_json(os.path.join(home, ".mcp.json"),
                       {"mcpServers": {"Known": {"type": "http", "url": "x"}}})
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            servers = co.discover_mcp_servers(repo, home=home,
                                              user_json_path="/nonexistent")
            servers = co.add_orphans(servers, {"Known", "GhostServer"})
            by_name = {s["name"]: s for s in servers}
            self.assertIn("GhostServer", by_name)
            self.assertTrue(by_name["GhostServer"]["orphan"])
            self.assertFalse(by_name["Known"]["orphan"])


class McpSettingsTests(unittest.TestCase):
    def _settings(self, home, repo, global_mode=False):
        # Point the module's CLAUDE_DIR at our temp home/.claude.
        co.CLAUDE_DIR = os.path.join(home, ".claude")
        return co.Settings(repo, global_mode=global_mode)

    def test_effective_defaults_off_when_unset(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            s = self._settings(home, repo)
            enabled, src = s.effective_mcp("Whatever")
            self.assertFalse(enabled)
            self.assertEqual(src, "default")

    def test_effective_reads_local_then_project_then_user(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(home, ".claude", "settings.json"),
                       {"enabledMcpjsonServers": ["U"]})
            write_json(os.path.join(repo, ".claude", "settings.json"),
                       {"disabledMcpjsonServers": ["P"]})
            write_json(os.path.join(repo, ".claude", "settings.local.json"),
                       {"enabledMcpjsonServers": ["L"]})
            s = self._settings(home, repo)
            self.assertEqual(s.effective_mcp("L"), (True, "local"))
            self.assertEqual(s.effective_mcp("P"), (False, "project"))
            self.assertEqual(s.effective_mcp("U"), (True, "user"))

    def test_local_overrides_user(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(home, ".claude", "settings.json"),
                       {"enabledMcpjsonServers": ["X"]})
            write_json(os.path.join(repo, ".claude", "settings.local.json"),
                       {"disabledMcpjsonServers": ["X"]})
            s = self._settings(home, repo)
            self.assertEqual(s.effective_mcp("X"), (False, "local"))

    def test_cycle_mcp_tristate_round_trip(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            s = self._settings(home, repo)
            local = os.path.join(repo, ".claude", "settings.local.json")

            s.cycle_mcp("S")  # unset -> enabled
            self.assertEqual(s.effective_mcp("S"), (True, "local"))
            self.assertEqual(load_doc(local).get("enabledMcpjsonServers"), ["S"])

            s.cycle_mcp("S")  # enabled -> disabled
            self.assertEqual(s.effective_mcp("S"), (False, "local"))
            self.assertEqual(load_doc(local).get("disabledMcpjsonServers"), ["S"])
            self.assertNotIn("S",
                             load_doc(local).get("enabledMcpjsonServers", []))

            s.cycle_mcp("S")  # disabled -> unset
            self.assertEqual(s.effective_mcp("S"), (False, "default"))
            doc = load_doc(local)
            self.assertNotIn("enabledMcpjsonServers", doc)
            self.assertNotIn("disabledMcpjsonServers", doc)

    def test_cycle_mcp_preserves_enabled_plugins(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            local = os.path.join(repo, ".claude", "settings.local.json")
            write_json(local, {"enabledPlugins": {"foo@bar": False}})
            s = self._settings(home, repo)
            s.cycle_mcp("S")
            doc = load_doc(local)
            self.assertEqual(doc["enabledPlugins"], {"foo@bar": False})
            self.assertEqual(doc["enabledMcpjsonServers"], ["S"])

    def test_global_mode_writes_user_settings(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            s = self._settings(home, repo, global_mode=True)
            s.cycle_mcp("G")
            user = os.path.join(home, ".claude", "settings.json")
            self.assertEqual(load_doc(user).get("enabledMcpjsonServers"), ["G"])
            self.assertEqual(s.effective_mcp("G"), (True, "user"))


class SkillSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.home = self.tempdir.name
        self.repo = os.path.join(self.home, "repo")
        self.user_path = os.path.join(self.home, ".claude", "settings.json")
        self.project_path = os.path.join(self.repo, ".claude", "settings.json")
        self.local_path = os.path.join(self.repo, ".claude", "settings.local.json")
        self.old_claude_dir = co.CLAUDE_DIR
        co.CLAUDE_DIR = os.path.join(self.home, ".claude")

    def tearDown(self):
        co.CLAUDE_DIR = self.old_claude_dir
        self.tempdir.cleanup()

    def _write_settings(self, user=None, project=None, local=None):
        for path, doc in ((self.user_path, user), (self.project_path, project),
                          (self.local_path, local)):
            if doc is not None:
                write_json(path, doc)

    def _settings(self, global_mode=False):
        return co.Settings(self.repo, global_mode=global_mode)

    def test_qualified_override_wins_before_plain_name(self):
        self._write_settings(
            user={"skillOverrides": {"apps/web:deploy": "off"}},
            local={"skillOverrides": {"deploy": "name-only"}},
        )
        self.assertEqual(self._settings().effective_skill("apps/web:deploy"),
                         ("off", "user"))

    def test_effective_skill_reads_each_scope_in_precedence_order(self):
        self._write_settings(
            user={"skillOverrides": {"user": "off", "shared": "off"}},
            project={"skillOverrides": {"project": "name-only",
                                         "shared": "name-only"}},
            local={"skillOverrides": {"local": "user-invocable-only",
                                       "shared": "user-invocable-only"}},
        )
        settings = self._settings()
        self.assertEqual(settings.effective_skill("local"),
                         ("user-invocable-only", "local"))
        self.assertEqual(settings.effective_skill("project"),
                         ("name-only", "project"))
        self.assertEqual(settings.effective_skill("user"), ("off", "user"))
        self.assertEqual(settings.effective_skill("shared"),
                         ("user-invocable-only", "local"))
        self.assertEqual(settings.effective_skill("unset"), ("on", "default"))

    def test_set_skill_rejects_invalid_state_without_writing(self):
        settings = self._settings()
        with self.assertRaises(ValueError):
            settings.set_skill("deploy", "disabled")
        self.assertFalse(os.path.exists(self.local_path))

    def test_cycles_and_clears_without_clobbering_other_keys(self):
        self._write_settings(local={
            "enabledPlugins": {"foo@bar": False},
            "enabledMcpjsonServers": ["mcp-a"],
        })
        settings = self._settings()
        for state in ("name-only", "user-invocable-only", "off", "on"):
            settings.cycle_skill("deploy")
            self.assertEqual(settings.effective_skill("deploy")[0], state)
        self.assertNotIn("skillOverrides", load_doc(self.local_path))
        settings.set_skill("deploy", "off")
        settings.clear_skill("deploy")
        doc = load_doc(self.local_path)
        self.assertNotIn("skillOverrides", doc)
        self.assertEqual(doc["enabledPlugins"], {"foo@bar": False})
        self.assertEqual(doc["enabledMcpjsonServers"], ["mcp-a"])

    def test_global_mode_mutates_user_skill_overrides(self):
        settings = self._settings(global_mode=True)
        settings.set_skill("deploy", "off")
        self.assertEqual(load_doc(self.user_path)["skillOverrides"],
                         {"deploy": "off"})
        self.assertEqual(settings.effective_skill("deploy"), ("off", "user"))

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


class SkillFrontmatterTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tempdir.cleanup()

    def _skill(self, contents):
        path = os.path.join(self.tempdir.name, "SKILL.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(contents)
        return path

    def test_parses_scalars_and_boolean(self):
        meta = co.parse_frontmatter(self._skill("""---
name: deploy
description: \"Deploy the service\"
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

    def test_false_boolean_disables_no_model_invocation_flag(self):
        meta = co.parse_frontmatter(self._skill("""---
disable-model-invocation: false
---
"""))
        self.assertFalse(meta["disable_model_invocation"])

    def test_quoted_true_enables_model_invocation_flag(self):
        meta = co.parse_frontmatter(self._skill("""---
disable-model-invocation: "true"
---
"""))
        self.assertTrue(meta["disable_model_invocation"])


class SkillDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.home = self.tempdir.name
        self.repo = os.path.join(self.home, "repo")
        self.claude_dir = os.path.join(self.home, ".claude")
        self.cache_dir = os.path.join(self.claude_dir, "plugins", "cache")
        self.registry = os.path.join(self.claude_dir, "plugins",
                                     "installed_plugins.json")
        self.old_claude_dir = co.CLAUDE_DIR
        co.CLAUDE_DIR = self.claude_dir

        self._skill(os.path.join(self.claude_dir, "skills", "deploy"),
                    "name: deploy\ndescription: Personal deploy")
        self._skill(os.path.join(self.claude_dir, "skills", "personal-only"),
                    "description: Personal only")
        self._skill(os.path.join(self.repo, ".claude", "skills", "deploy"),
                    "description: Project deploy")
        self._skill(os.path.join(self.repo, "apps", "web", ".claude", "skills",
                                 "deploy"),
                    "description: Scoped deploy")
        self._plugin_skill("disabled", "m", "run", "description: Disabled")
        self._plugin_skill("stale", "m", "run", "description: Stale")
        write_json(self.registry, {"plugins": {"disabled@m": {}}})
        write_json(os.path.join(self.repo, ".claude", "settings.local.json"),
                   {"enabledPlugins": {"disabled@m": False}})
        self.settings = co.Settings(self.repo)

    def tearDown(self):
        co.CLAUDE_DIR = self.old_claude_dir
        self.tempdir.cleanup()

    def _skill(self, directory, frontmatter):
        write_file(os.path.join(directory, "SKILL.md"), f"---\n{frontmatter}\n---\n")

    def _plugin_skill(self, plugin, marketplace, skill, frontmatter):
        self._skill(os.path.join(self.cache_dir, marketplace, plugin, "1.0.0",
                                 "skills", skill), frontmatter)

    def _discover(self, start_dir):
        return co.discover_skills(start_dir, self.repo, self.home, self.settings,
                                  claude_dir=self.claude_dir,
                                  cache_dir=self.cache_dir,
                                  installed_plugins_path=self.registry)

    def test_discovers_personal_root_and_scoped_project_skills(self):
        skills = self._discover(os.path.join(self.repo, "apps", "web"))
        self.assertEqual({s["address"] for s in skills},
                         {"deploy", "apps/web:deploy", "personal-only"})
        scoped = next(s for s in skills if s["address"] == "apps/web:deploy")
        self.assertEqual(scoped["metadata"]["description"], "Scoped deploy")
        self.assertEqual(scoped["kind"], "skill")
        self.assertEqual(scoped["plugin_key"], None)

    def test_collapses_collisions_and_excludes_inactive_plugins(self):
        self._plugin_skill("active", "m", "run", "name: run\ndescription: Active")
        write_json(self.registry, {"plugins": {"active@m": {}, "disabled@m": {}}})
        skills = self._discover(self.repo)
        deploy = next(s for s in skills if s["address"] == "deploy")
        self.assertEqual(len(deploy["collision_paths"]), 2)
        self.assertEqual(deploy["paths"], [os.path.join(self.claude_dir, "skills",
                                                         "deploy", "SKILL.md")])
        self.assertIn("active:run", {s["address"] for s in skills})
        self.assertNotIn("stale:run", {s["address"] for s in skills})
        self.assertNotIn("disabled:run", {s["address"] for s in skills})


class SkillDisplayTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.home = self.tempdir.name
        self.repo = os.path.join(self.home, "repo")
        self.old_claude_dir = co.CLAUDE_DIR
        co.CLAUDE_DIR = os.path.join(self.home, ".claude")

    def tearDown(self):
        co.CLAUDE_DIR = self.old_claude_dir
        self.tempdir.cleanup()

    def _skill_record(self, address="ship", source="personal", metadata=None):
        return co._skill_record(
            address, "Ship it", source, "/tmp/SKILL.md",
            metadata or {"description": "Ship it", "when_to_use": "after tests",
                         "disable_model_invocation": False},
        )

    def _settings_with(self, state, address="ship"):
        settings = co.Settings(self.repo)
        settings.set_skill(address, state)
        return settings

    def _plugin_skill(self):
        return self._skill_record(address="active:ship", source="plugin")

    def _locked_skill(self):
        return self._skill_record(metadata={
            "description": "Ship it",
            "when_to_use": "after tests",
            "disable_model_invocation": True,
        })

    def test_skill_display_costs_follow_effective_state(self):
        skill = self._skill_record()
        self.assertEqual(co.skill_display(skill, self._settings_with("on")), {
            "state": "on", "source": "local", "author_locked": False,
            "inert_override": False, "resident_tokens": 7,
        })
        self.assertEqual(co.skill_display(skill, self._settings_with("name-only")), {
            "state": "name-only", "source": "local", "author_locked": False,
            "inert_override": False, "resident_tokens": 2,
        })
        self.assertEqual(co.skill_display(skill, self._settings_with("user-invocable-only")), {
            "state": "user-invocable-only", "source": "local",
            "author_locked": False, "inert_override": False, "resident_tokens": 0,
        })
        self.assertEqual(co.skill_display(skill, self._settings_with("off")), {
            "state": "off", "source": "local", "author_locked": False,
            "inert_override": False, "resident_tokens": 0,
        })

    def test_plugin_and_author_locks_make_override_inert(self):
        plugin = co.skill_display(
            self._plugin_skill(), self._settings_with("off", "active:ship"))
        locked = co.skill_display(self._locked_skill(), self._settings_with("off"))
        self.assertEqual(plugin, {
            "state": "on", "source": "local", "author_locked": False,
            "inert_override": True, "resident_tokens": 7,
        })
        self.assertEqual(locked, {
            "state": "user-invocable-only", "source": "local",
            "author_locked": True, "inert_override": True, "resident_tokens": 0,
        })


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


class PluginCountTests(unittest.TestCase):
    def _plugin(self, name):
        return {"key": f"{name}@m", "name": name, "installed": True}

    def test_counts_use_boolean_value_not_key_presence(self):
        # a@m is an explicit false, b@m an explicit true, c@m has no key at
        # all (so it defaults on since it's installed) -- key presence alone
        # must not be mistaken for "enabled".
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            write_json(os.path.join(home, ".claude", "settings.json"),
                       {"enabledPlugins": {"a@m": False, "b@m": True}})
            co.CLAUDE_DIR = os.path.join(home, ".claude")
            s = co.Settings(repo, global_mode=True)
            plugins = [self._plugin("a"), self._plugin("b"), self._plugin("c")]
            self.assertEqual(s.counts(plugins), (2, 1))


class RowBuildingTests(unittest.TestCase):
    def _plugin(self, name):
        return {"kind": "plugin", "key": f"{name}@m", "name": name,
                "marketplace": "m", "skills": [], "agents": [],
                "other_items": [], "est_tokens": 0, "installed": True}

    def _server(self, name):
        return co._mcp_entry(name, {"type": "http", "url": "x"}, "ws/.mcp.json")

    def test_rows_have_no_section_headers(self):
        # Tabs replace inline section headers; each tab's display holds one
        # kind, and build_rows emits only entry rows (+ expanded sub-rows).
        rows = co.build_rows([self._plugin("P1"), self._plugin("P2")], set())
        self.assertEqual([r[0] for r in rows], ["plugin", "plugin"])

    def test_expanded_mcp_shows_detail_rows(self):
        s = self._server("S1")
        rows = co.build_rows([s], {s["key"]})
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds[0], "mcp")
        self.assertIn("mcp-detail", kinds)

    def test_expanded_plugin_uses_namespaced_child_kinds(self):
        plugin = self._plugin("P1")
        plugin["skills"] = [("run", "desc")]
        plugin["agents"] = [("bot", "desc")]
        plugin["other_items"] = [("hooks/pre.sh", "")]
        rows = co.build_rows([plugin], {plugin["key"]})
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds, ["plugin", "plugin-skill", "plugin-agent",
                                  "plugin-other"])

    def _skill_entry(self, address, collision_paths=None, source=None,
                      author_locked=False, plugin_key=None):
        return {"kind": "skill", "key": address, "address": address,
                "collision_paths": collision_paths or [], "source": source,
                "author_locked": author_locked, "plugin_key": plugin_key}

    def test_rows_include_bare_skill_kind(self):
        rows = co.build_rows([self._skill_entry("deploy")], set())
        self.assertEqual([r[0] for r in rows], ["skill"])

    def test_expanded_skill_with_collisions_shows_detail_rows(self):
        entry = self._skill_entry("deploy", collision_paths=["/a/SKILL.md", "/b/SKILL.md"])
        rows = co.build_rows([entry], {entry["key"]})
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds, ["skill", "skill-detail"])
        self.assertEqual(rows[1][2], "/b/SKILL.md")

    def test_expanded_plugin_skill_explains_the_plugin_lock(self):
        entry = self._skill_entry("run", source="plugin", plugin_key="active@m")
        rows = co.build_rows([entry], {entry["key"]}, detail_wrap_width=200)
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds, ["skill", "skill-lock-reason"])
        self.assertIn("locked by plugin", rows[1][2])
        self.assertIn("active@m", rows[1][2])

    def test_expanded_author_locked_skill_explains_the_lock(self):
        entry = self._skill_entry("deploy", author_locked=True)
        rows = co.build_rows([entry], {entry["key"]}, detail_wrap_width=200)
        kinds = [r[0] for r in rows]
        self.assertEqual(kinds, ["skill", "skill-lock-reason"])
        self.assertIn("locked by author", rows[1][2])
        self.assertIn("disable-model-invocation", rows[1][2])

    def test_lock_reason_soft_wraps_at_the_given_width(self):
        entry = self._skill_entry("run", source="plugin", plugin_key="active@m")
        rows = co.build_rows([entry], {entry["key"]}, detail_wrap_width=20)
        kinds = [r[0] for r in rows]
        self.assertGreater(kinds.count("skill-lock-reason"), 1)
        for _, _, text in rows[1:]:
            self.assertLessEqual(len(text), 20)

    def test_expanded_skill_without_collisions_shows_empty_row(self):
        entry = self._skill_entry("deploy")
        rows = co.build_rows([entry], {entry["key"]})
        self.assertEqual([r[0] for r in rows], ["skill", "empty"])


class LegendWrapTests(unittest.TestCase):
    def test_wide_width_fits_on_one_line(self):
        lines = co.wrap_legend(co.LEGEND_ITEMS, 500)
        self.assertEqual(len(lines), 1)

    def test_narrow_width_wraps_to_multiple_lines_without_splitting_items(self):
        width = 40
        lines = co.wrap_legend(co.LEGEND_ITEMS, width)
        self.assertGreater(len(lines), 1)
        longest_item = max(sum(len(t) for t, _ in item) for item in co.LEGEND_ITEMS)
        for line in lines:
            # a line may exceed width, but never by more than one item's
            # worth — that's the only way a single (unsplittable) item
            # wider than `width` can legally land on its own line.
            self.assertLessEqual(sum(len(t) for t, _ in line),
                                 width + longest_item)
        # content is preserved verbatim, in order, across the wrapped lines
        rebuilt = [t for line in lines for t, _ in line]
        original = [t for item in co.LEGEND_ITEMS for t, _ in item]
        self.assertEqual(rebuilt, original)

    def test_zero_width_still_returns_each_item_on_its_own_line(self):
        lines = co.wrap_legend(co.LEGEND_ITEMS, 1)
        self.assertEqual(len(lines), len(co.LEGEND_ITEMS))


def load_doc(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    unittest.main(verbosity=2)
