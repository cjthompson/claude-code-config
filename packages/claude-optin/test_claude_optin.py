#!/usr/bin/env python3
"""Tests for claude-optin's pure logic (MCP discovery + settings).

The TUI/curses parts aren't exercised here — only the data layer:
MCP server discovery (the .mcp.json walk + orphan detection) and the
Settings class's MCP enable/disable resolution and cycling.

Run: python3 packages/claude-optin/test_claude_optin.py
"""

import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from unittest import mock


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
    def setUp(self):
        self._old_claude_dir = co.CLAUDE_DIR

    def tearDown(self):
        co.CLAUDE_DIR = self._old_claude_dir

    def _settings(self, home, repo, global_mode=False, trusted=True):
        # Point the module's CLAUDE_DIR at our temp home/.claude.
        co.CLAUDE_DIR = os.path.join(home, ".claude")
        return co.Settings(repo, global_mode=global_mode, trusted=trusted)

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

    def test_mcp_mark_returns_distinct_marks_across_cycle(self):
        """Verify that each SPACE press produces a visibly different mark,
        cycling approved -> hidden -> pending -> approved."""
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            s = self._settings(home, repo)

            # Start unset (pending): dim dot
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"]), ("pending", "default"))
            mark1, _ = co.mcp_mark(st["state"], st["blocked_by"], False)
            self.assertEqual(mark1, "·")

            # Press 1: pending -> approved
            s.cycle_mcp("S")
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"]), ("approved", "local"))
            mark2, _ = co.mcp_mark(st["state"], st["blocked_by"], False)
            self.assertEqual(mark2, "✓")
            self.assertNotEqual(mark1, mark2)

            # Press 2: approved -> hidden
            s.cycle_mcp("S")
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"]), ("hidden", "local"))
            mark3, _ = co.mcp_mark(st["state"], st["blocked_by"], False)
            self.assertEqual(mark3, "✗")
            self.assertNotEqual(mark2, mark3)
            self.assertNotEqual(mark1, mark3)

            # Press 3: hidden -> pending
            s.cycle_mcp("S")
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"]), ("pending", "default"))
            mark4, _ = co.mcp_mark(st["state"], st["blocked_by"], False)
            self.assertEqual(mark4, "·")
            self.assertEqual(mark1, mark4)

    def test_mcp_mark_unit_assertions(self):
        """Direct unit tests for mcp_mark behavior — all 5 table rows."""
        # Pending (unset everywhere or untrusted enable): dim dot
        mark, kind = co.mcp_mark("pending", None, False)
        self.assertEqual(mark, "·")
        self.assertEqual(kind, "dim")

        # Hidden (disabled somewhere): red cross
        mark, kind = co.mcp_mark("hidden", None, False)
        self.assertEqual(mark, "✗")
        self.assertEqual(kind, "red")

        # Approved: green checkmark
        mark, kind = co.mcp_mark("approved", None, False)
        self.assertEqual(mark, "✓")
        self.assertEqual(kind, "green")

        # Blocked by another layer or by trust: orange bang, regardless of state
        mark, kind = co.mcp_mark("hidden", "project", False)
        self.assertEqual(mark, "!")
        self.assertEqual(kind, "orange")

        # Orphan: yellow question mark (state/blocked_by don't matter for orphans)
        mark, kind = co.mcp_mark("approved", None, True)
        self.assertEqual(mark, "?")
        self.assertEqual(kind, "yellow")

    def test_project_disable_cycle_is_blocked(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(repo, ".claude", "settings.json"),
                       {"disabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo)
            s.cycle_mcp("S")
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "project", "project"))
            self.assertIs(st["intent"], True)
            self.assertEqual(s.effective_mcp("S"), (False, "project"))

    def test_project_disable_cycle_sequence(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(repo, ".claude", "settings.json"),
                       {"disabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo)

            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "project", None))

            s.cycle_mcp("S")
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "project", "project"))

            s.cycle_mcp("S")
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "local", None))

            s.cycle_mcp("S")
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "project", None))

    def test_user_disable_then_local_enable_is_blocked_by_user(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            write_json(os.path.join(home, ".claude", "settings.json"),
                       {"disabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo)

            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "user", None))

            s.cycle_mcp("S")   # local: unset -> enabled
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "user", "user"))

    def test_local_disable_over_project_enable(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(repo, ".claude", "settings.json"),
                       {"enabledMcpjsonServers": ["S"]})
            write_json(os.path.join(repo, ".claude", "settings.local.json"),
                       {"disabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo)
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("hidden", "local", None))

    def test_untrusted_local_enable_is_pending_until_trusted(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(repo, ".claude", "settings.local.json"),
                       {"enabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo, trusted=False)

            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("pending", "local", "untrusted"))
            self.assertEqual(s.effective_mcp("S"), (False, "local"))

            s.trusted = True   # no caching: same instance, fresh read
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"], st["blocked_by"]),
                             ("approved", "local", None))

    def test_untrusted_local_disable_is_still_hidden(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(repo, ".claude", "settings.local.json"),
                       {"disabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo, trusted=False)
            self.assertEqual(s.mcp_status("S")["state"], "hidden")

    def test_name_in_both_local_lists_then_two_cycles(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            local = os.path.join(repo, ".claude", "settings.local.json")
            write_json(local, {"enabledMcpjsonServers": ["S"],
                               "disabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo)
            self.assertEqual(s.mcp_status("S")["state"], "hidden")

            s.cycle_mcp("S")
            doc = load_doc(local)
            self.assertNotIn("S", doc.get("enabledMcpjsonServers", []))
            self.assertNotIn("S", doc.get("disabledMcpjsonServers", []))
            st = s.mcp_status("S")
            self.assertEqual((st["state"], st["source"]), ("pending", "default"))

            s.cycle_mcp("S")
            doc = load_doc(local)
            self.assertEqual(doc.get("enabledMcpjsonServers"), ["S"])
            self.assertNotIn("S", doc.get("disabledMcpjsonServers", []))

    def test_duplicate_enable_entries_collapse_on_cycle(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            local = os.path.join(repo, ".claude", "settings.local.json")
            write_json(local, {"enabledMcpjsonServers": ["S", "S"]})
            s = self._settings(home, repo)
            s.cycle_mcp("S")
            doc = load_doc(local)
            self.assertEqual(doc.get("disabledMcpjsonServers"), ["S"])
            self.assertNotIn("S", doc.get("enabledMcpjsonServers", []))

    def test_full_cycle_returns_to_start_from_each_seed(self):
        seeds = [
            ("approved", {"enabledMcpjsonServers": ["S"]}),
            ("hidden", {"disabledMcpjsonServers": ["S"]}),
            ("pending", None),
        ]
        for label, seed_doc in seeds:
            with self.subTest(seed=label):
                with tempfile.TemporaryDirectory() as home:
                    repo = os.path.join(home, "repo")
                    local = os.path.join(repo, ".claude", "settings.local.json")
                    if seed_doc is not None:
                        write_json(local, seed_doc)
                    else:
                        os.makedirs(repo)
                    s = self._settings(home, repo)
                    start = load_doc(local) if os.path.isfile(local) else {}
                    for _ in range(3):
                        s.cycle_mcp("S")
                        # every intermediate write is a valid, distinct state
                        self.assertIn(s.mcp_status("S")["state"],
                                     ("approved", "hidden", "pending"))
                    end = load_doc(local) if os.path.isfile(local) else {}
                    self.assertEqual(start.get("enabledMcpjsonServers", []),
                                     end.get("enabledMcpjsonServers", []))
                    self.assertEqual(start.get("disabledMcpjsonServers", []),
                                     end.get("disabledMcpjsonServers", []))

    def test_global_mode_ignores_project_disable(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            write_json(os.path.join(repo, ".claude", "settings.json"),
                       {"disabledMcpjsonServers": ["S"]})
            s = self._settings(home, repo, global_mode=True)
            st = s.mcp_status("S")
            self.assertEqual(st["state"], "pending")
            self.assertIsNone(st["blocked_by"])


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


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def make_worktree(main, wt, name="wt", commondir="../..", backlink=None,
                  gitdir_line=None, common=None):
    """Hand-build git's linked-worktree layout with plain files (all paths absolute/real)."""
    common = common or os.path.join(main, ".git")
    gitdir = os.path.join(common, "worktrees", name)
    os.makedirs(gitdir, exist_ok=True)
    os.makedirs(wt, exist_ok=True)
    if commondir is not None:
        with open(os.path.join(gitdir, "commondir"), "w") as f:
            f.write(commondir + "\n")
    with open(os.path.join(gitdir, "gitdir"), "w") as f:
        f.write((backlink or os.path.join(wt, ".git")) + "\n")
    with open(os.path.join(wt, ".git"), "w") as f:
        f.write(gitdir_line or f"gitdir: {gitdir}\n")
    return gitdir


class LoadJsonStrictTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.old_path = co.CLAUDE_JSON_PATH
        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_raises_on_missing_file(self):
        with self.assertRaises(OSError):
            co.load_json_strict("/nonexistent/path")

    def test_raises_on_malformed_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "bad.json")
            with open(path, "w") as f:
                f.write("{invalid json")
            with self.assertRaises(json.JSONDecodeError):
                co.load_json_strict(path)

    def test_raises_on_non_dict_top_level(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "array.json")
            with open(path, "w") as f:
                json.dump([], f)
            with self.assertRaises(ValueError):
                co.load_json_strict(path)

    def test_succeeds_on_valid_dict(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "good.json")
            with open(path, "w") as f:
                json.dump({"key": "value"}, f)
            result = co.load_json_strict(path)
            self.assertEqual(result, {"key": "value"})


class ResolveTrustKeyTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.root = os.path.realpath(self.tmpdir)
        self.old_path = co.CLAUDE_JSON_PATH
        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_resolves_git_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            git_dir = os.path.join(tmpdir, "repo", ".git")
            os.makedirs(git_dir)
            start = os.path.join(tmpdir, "repo", "subdir")
            os.makedirs(start)
            key = co.resolve_trust_key(start)
            self.assertEqual(key, os.path.realpath(os.path.join(tmpdir, "repo")))

    def test_resolves_git_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            git_file = os.path.join(tmpdir, "repo", ".git")
            os.makedirs(os.path.dirname(git_file))
            with open(git_file, "w") as f:
                f.write("gitdir: /some/path\n")
            start = os.path.join(tmpdir, "repo", "subdir")
            os.makedirs(start)
            key = co.resolve_trust_key(start)
            self.assertEqual(key, os.path.realpath(os.path.join(tmpdir, "repo")))

    def test_returns_start_when_no_git(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            start = os.path.join(tmpdir, "nosgit")
            os.makedirs(start)
            key = co.resolve_trust_key(start)
            self.assertEqual(key, os.path.realpath(start))

    def test_bare_claude_dir_not_a_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            start = os.path.join(tmpdir, "bare", ".claude")
            os.makedirs(start)
            # resolve_trust_key finds no .git, so returns the start_dir
            key = co.resolve_trust_key(start)
            self.assertEqual(key, os.path.realpath(start))

    def test_symlinked_path_resolves_to_realpath(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            real_dir = os.path.join(tmpdir, "real")
            os.makedirs(real_dir)
            git_dir = os.path.join(real_dir, ".git")
            os.makedirs(git_dir)
            link_dir = os.path.join(tmpdir, "link")
            os.symlink(real_dir, link_dir)
            key = co.resolve_trust_key(link_dir)
            self.assertEqual(key, os.path.realpath(real_dir))

    def test_uses_cwd_when_no_start_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            git_dir = os.path.join(tmpdir, ".git")
            os.makedirs(git_dir)
            old_cwd = os.getcwd()
            try:
                os.chdir(tmpdir)
                key = co.resolve_trust_key()
                self.assertEqual(key, os.path.realpath(tmpdir))
            finally:
                os.chdir(old_cwd)

    def test_linked_worktree_resolves_to_main_checkout(self):
        main = os.path.join(self.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(self.root, "wt")
        make_worktree(main, wt)
        os.makedirs(os.path.join(wt, "sub"))
        self.assertEqual(co.resolve_trust_key(os.path.join(wt, "sub")), main)

    def test_linked_worktree_relative_gitdir(self):
        main = os.path.join(self.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(self.root, "wt")
        make_worktree(main, wt, gitdir_line="gitdir: ../main/.git/worktrees/wt\n")
        self.assertEqual(co.resolve_trust_key(wt), main)

    def test_nested_worktree_inside_main_checkout(self):
        main = os.path.join(self.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(main, ".claude", "worktrees", "x")
        make_worktree(main, wt, name="x")
        self.assertEqual(co.resolve_trust_key(wt), main)

    def test_submodule_style_git_file_keeps_own_path(self):
        super_dir = os.path.join(self.root, "super")
        os.makedirs(os.path.join(super_dir, ".git"))
        os.makedirs(os.path.join(super_dir, ".git", "modules", "sub"))
        sub = os.path.join(super_dir, "sub")
        os.makedirs(sub)
        with open(os.path.join(super_dir, ".git", "modules", "sub", "HEAD"), "w") as f:
            f.write("ref: refs/heads/main\n")
        with open(os.path.join(sub, ".git"), "w") as f:
            f.write("gitdir: ../.git/modules/sub\n")
        self.assertEqual(co.resolve_trust_key(sub), sub)

    def test_missing_commondir_keeps_own_path(self):
        main = os.path.join(self.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(self.root, "wt")
        make_worktree(main, wt, commondir=None)
        self.assertEqual(co.resolve_trust_key(wt), wt)

    def test_symlinked_commondir_keeps_own_path(self):
        main = os.path.join(self.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(self.root, "wt")
        make_worktree(main, wt)
        commondir_path = os.path.join(os.path.join(main, ".git", "worktrees", "wt"), "commondir")
        os.remove(commondir_path)
        target_file = os.path.join(self.root, "commondir_target")
        with open(target_file, "w") as f:
            f.write("../..\n")
        os.symlink(target_file, commondir_path)
        self.assertEqual(co.resolve_trust_key(wt), wt)

    def test_wrong_backlink_keeps_own_path(self):
        main = os.path.join(self.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(self.root, "wt")
        elsewhere = os.path.join(self.root, "elsewhere")
        os.makedirs(elsewhere)
        make_worktree(main, wt, backlink=os.path.join(elsewhere, ".git"))
        self.assertEqual(co.resolve_trust_key(wt), wt)

    def test_gitdir_not_under_worktrees_keeps_own_path(self):
        main = os.path.join(self.root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(self.root, "wt")
        make_worktree(main, wt, commondir="../../..")
        self.assertEqual(co.resolve_trust_key(wt), wt)

    def test_bare_common_dir_resolves_to_common_dir(self):
        bare = os.path.join(self.root, "repo.git")
        os.makedirs(bare)
        wt = os.path.join(self.root, "wt")
        make_worktree(None, wt, commondir="../..", common=bare)
        self.assertEqual(co.resolve_trust_key(wt), bare)

    def test_bare_common_dir_with_inner_git_keeps_own_path(self):
        bare = os.path.join(self.root, "repo.git")
        os.makedirs(bare)
        os.makedirs(os.path.join(bare, ".git"))
        wt = os.path.join(self.root, "wt")
        make_worktree(None, wt, commondir="../..", common=bare)
        self.assertEqual(co.resolve_trust_key(wt), wt)

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_real_git_worktree_resolves_to_main_checkout(self):
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        main = os.path.join(self.root, "main")
        wt = os.path.join(self.root, "wt")
        run = lambda *a: subprocess.run(["git", *a], check=True, env=env,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run("init", "-q", main)
        run("-C", main, "-c", "user.name=t", "-c", "user.email=t@e",
            "commit", "-q", "--allow-empty", "-m", "init")
        run("-C", main, "worktree", "add", "-q", wt)
        self.assertEqual(co.resolve_trust_key(wt), main)


class TrustEntryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.old_path = co.CLAUDE_JSON_PATH
        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_get_trust_returns_none_for_missing_entry(self):
        write_json(self.claude_json, {})
        result = co.get_trust("/some/path", user_json_path=self.claude_json)
        self.assertIsNone(result)

    def test_get_trust_returns_false_for_missing_flag(self):
        path = os.path.realpath("/some/path")
        write_json(self.claude_json, {"projects": {path: {}}})
        result = co.get_trust(path, user_json_path=self.claude_json)
        self.assertFalse(result)

    def test_get_trust_returns_explicit_true(self):
        path = os.path.realpath("/some/path")
        write_json(self.claude_json, {"projects": {path: {"hasTrustDialogAccepted": True}}})
        result = co.get_trust(path, user_json_path=self.claude_json)
        self.assertTrue(result)

    def test_discover_trust_entries_sorted_by_path(self):
        paths = ["/z/path", "/a/path"]
        doc = {"projects": {
            paths[0]: {"hasTrustDialogAccepted": True},
            paths[1]: {"hasTrustDialogAccepted": False},
        }}
        write_json(self.claude_json, doc)
        entries = co.discover_trust_entries(user_json_path=self.claude_json)
        self.assertEqual([e["path"] for e in entries], sorted(paths))

    def test_discover_trust_entries_includes_onboarding_fields(self):
        path = os.path.realpath("/some/path")
        doc = {"projects": {path: {
            "hasTrustDialogAccepted": True,
            "projectOnboardingSeenCount": 5,
            "hasCompletedProjectOnboarding": True,
        }}}
        write_json(self.claude_json, doc)
        entries = co.discover_trust_entries(user_json_path=self.claude_json)
        entry = entries[0]
        self.assertEqual(entry["onboarding_seen_count"], 5)
        self.assertTrue(entry["has_completed_onboarding"])

    def test_discover_trust_entries_onboarding_fields_none_when_absent(self):
        path = os.path.realpath("/some/path")
        write_json(self.claude_json, {"projects": {path: {}}})
        entries = co.discover_trust_entries(user_json_path=self.claude_json)
        entry = entries[0]
        self.assertIsNone(entry["onboarding_seen_count"])
        self.assertIsNone(entry["has_completed_onboarding"])

    def test_get_trust_non_dict_entry_is_false(self):
        p = os.path.realpath("/path")
        write_json(self.claude_json, {"projects": {p: "x"}})
        result = co.get_trust(p, user_json_path=self.claude_json)
        self.assertIs(result, False)

    def test_get_trust_requires_exact_true(self):
        p = os.path.realpath("/path")
        write_json(self.claude_json, {"projects": {p: {"hasTrustDialogAccepted": "true"}}})
        result = co.get_trust(p, user_json_path=self.claude_json)
        self.assertIs(result, False)

    def test_read_helpers_tolerate_non_dict_projects(self):
        write_json(self.claude_json, {"projects": []})
        result_get = co.get_trust(os.path.realpath("/path"), user_json_path=self.claude_json)
        self.assertIsNone(result_get)
        result_discover = co.discover_trust_entries(user_json_path=self.claude_json)
        self.assertEqual(result_discover, [])
        write_json(self.claude_json, [])
        result_get2 = co.get_trust(os.path.realpath("/path"), user_json_path=self.claude_json)
        self.assertIsNone(result_get2)
        result_discover2 = co.discover_trust_entries(user_json_path=self.claude_json)
        self.assertEqual(result_discover2, [])


class TrustSuppressorTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.old_path = co.CLAUDE_JSON_PATH
        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_worktree_own_root_reported_when_key_is_main_checkout(self):
        root = os.path.realpath(self.tmpdir)
        main = os.path.join(root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(root, "wt")
        make_worktree(main, wt)
        sub = os.path.join(wt, "sub")
        os.makedirs(sub)
        wt_real = os.path.realpath(wt)
        write_json(self.claude_json, {"projects": {wt_real: {"hasTrustDialogAccepted": True}}})
        self.assertEqual(co.resolve_trust_key(sub), main)
        self.assertEqual(co.trust_suppressor(sub, user_json_path=self.claude_json), wt_real)

    def test_walk_bounded_by_worktree_root_not_main_checkout(self):
        root = os.path.realpath(self.tmpdir)
        main = os.path.join(root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(main, ".claude", "worktrees", "x")
        make_worktree(main, wt, name="x")
        write_json(self.claude_json, {"projects": {
            os.path.join(main, ".claude"): {"hasTrustDialogAccepted": True}}})
        result = co.trust_suppressor(wt, user_json_path=self.claude_json)
        self.assertIsNone(result)

    def test_key_is_keyword_only(self):
        with self.assertRaises(TypeError):
            co.trust_suppressor("/path", self.claude_json, "/path")

    def test_non_dict_entries_and_projects_ignored(self):
        tmpdir = self.tmpdir
        repo = os.path.join(tmpdir, "repo")
        os.makedirs(os.path.join(repo, ".git"))
        start = os.path.join(repo, "a", "b")
        os.makedirs(start)
        repo_a = os.path.realpath(os.path.join(repo, "a"))
        repo_ab = os.path.realpath(start)
        write_json(self.claude_json, {"projects": {
            repo_a: "yes",
            repo_ab: None,
        }})
        result = co.trust_suppressor(start, user_json_path=self.claude_json)
        self.assertIsNone(result)
        write_json(self.claude_json, {"projects": []})
        result2 = co.trust_suppressor(start, user_json_path=self.claude_json)
        self.assertIsNone(result2)
        write_json(self.claude_json, [])
        result3 = co.trust_suppressor(start, user_json_path=self.claude_json)
        self.assertIsNone(result3)

    def test_finds_ancestor_within_git_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = os.path.join(tmpdir, "repo")
            os.makedirs(os.path.join(repo, ".git"))
            ancestor = os.path.join(repo, "a")
            start = os.path.join(repo, "a", "b", "c")
            os.makedirs(start)  # makedirs creates ancestor, a, and start

            ancestor_real = os.path.realpath(ancestor)
            write_json(self.claude_json, {"projects": {
                ancestor_real: {"hasTrustDialogAccepted": True}
            }})

            result = co.trust_suppressor(start, user_json_path=self.claude_json)
            self.assertEqual(result, ancestor_real)

    def test_ignores_trusted_ancestor_above_git_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = os.path.join(tmpdir, "repo")
            os.makedirs(os.path.join(repo, ".git"))
            start = os.path.join(repo, "sub")
            os.makedirs(start)
            above_root = os.path.realpath(tmpdir)  # direct parent of the git root
            write_json(self.claude_json, {"projects": {
                above_root: {"hasTrustDialogAccepted": True}
            }})
            result = co.trust_suppressor(start, user_json_path=self.claude_json)
            self.assertIsNone(result)

    def test_does_not_report_key_itself_as_suppressor(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = os.path.join(tmpdir, "repo")
            os.makedirs(os.path.join(repo, ".git"))
            key = os.path.realpath(repo)
            write_json(self.claude_json, {"projects": {
                key: {"hasTrustDialogAccepted": True}
            }})

            result = co.trust_suppressor(repo, key=key, user_json_path=self.claude_json)
            self.assertIsNone(result)


class SetTrustTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.old_path = co.CLAUDE_JSON_PATH
        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_raises_on_malformed_file(self):
        with open(self.claude_json, "w") as f:
            f.write("{invalid")
        with self.assertRaises(json.JSONDecodeError):
            co.set_trust("/path", True, user_json_path=self.claude_json)
        # Verify file untouched
        with open(self.claude_json) as f:
            self.assertEqual(f.read(), "{invalid")

    def test_none_removes_flag_keeps_entry(self):
        p = os.path.realpath(os.path.join(self.tmpdir, "p"))
        write_json(self.claude_json, {"projects": {
            p: {"hasTrustDialogAccepted": False, "allowedTools": []}}})
        self.assertEqual(co.set_trust(p, None, user_json_path=self.claude_json),
                         (False, None))
        self.assertEqual(load_doc(self.claude_json)["projects"][p], {"allowedTools": []})

    def test_none_is_no_op_when_flag_absent(self):
        p = os.path.realpath(os.path.join(self.tmpdir, "p"))
        write_json(self.claude_json, {"projects": {p: {"allowedTools": []}}})
        before = os.stat(self.claude_json).st_mtime_ns
        co.set_trust(p, None, user_json_path=self.claude_json)
        co.set_trust(os.path.join(self.tmpdir, "missing"), None,
                     user_json_path=self.claude_json)
        self.assertEqual(os.stat(self.claude_json).st_mtime_ns, before)

    def test_preserves_all_other_keys_value_identical(self):
        p = os.path.realpath("/path")
        other = os.path.realpath("/other")
        original = {
            "numStartups": 42,
            "oauthAccount": {"a": [1, {"b": None}], "c": "é"},
            "mcpServers": {"S": {"command": "x", "args": ["-y"]}},
            "projects": {
                p: {"hasTrustDialogAccepted": False, "allowedTools": ["Bash"],
                    "projectOnboardingSeenCount": 3, "mcpServers": {"m": {}}},
                other: {"hasTrustDialogAccepted": True, "x": [1, 2]},
            },
        }
        write_json(self.claude_json, original)
        co.set_trust(p, True, user_json_path=self.claude_json)
        expected = copy.deepcopy(original)
        expected["projects"][p]["hasTrustDialogAccepted"] = True
        self.assertEqual(load_doc(self.claude_json), expected)

    def test_creates_default_object_for_new_entry(self):
        write_json(self.claude_json, {})
        path = os.path.realpath("/path")
        co.set_trust(path, True, user_json_path=self.claude_json)
        doc = load_doc(self.claude_json)
        entry = doc["projects"][path]
        self.assertTrue(entry["hasTrustDialogAccepted"])
        self.assertIn("allowedTools", entry)
        self.assertIn("mcpServers", entry)

    def test_no_op_when_unchanged(self):
        path = os.path.realpath("/path")
        write_json(self.claude_json, {"projects": {
            path: {"hasTrustDialogAccepted": True}
        }})
        stat_before = os.stat(self.claude_json)
        co.set_trust(path, True, user_json_path=self.claude_json)
        stat_after = os.stat(self.claude_json)
        self.assertEqual(stat_before.st_mtime_ns, stat_after.st_mtime_ns)

    def test_no_op_when_setting_false_with_no_entry(self):
        write_json(self.claude_json, {})
        path = os.path.realpath("/path")
        stat_before = os.stat(self.claude_json)
        old, new = co.set_trust(path, False, user_json_path=self.claude_json)
        self.assertEqual((old, new), (None, None))
        stat_after = os.stat(self.claude_json)
        self.assertEqual(stat_before.st_mtime_ns, stat_after.st_mtime_ns)
        doc = load_doc(self.claude_json)
        self.assertNotIn(path, doc.get("projects", {}))

    def test_preserves_file_mode(self):
        if sys.platform == "win32":
            self.skipTest("File mode test not applicable on Windows")
        write_json(self.claude_json, {})
        os.chmod(self.claude_json, 0o640)
        path = os.path.realpath("/path")
        co.set_trust(path, True, user_json_path=self.claude_json)
        mode = stat.S_IMODE(os.stat(self.claude_json).st_mode)
        self.assertEqual(mode, 0o640)

    def test_returns_old_new_tuple(self):
        path = os.path.realpath("/path")
        write_json(self.claude_json, {})
        old1, new1 = co.set_trust(path, True, user_json_path=self.claude_json)
        self.assertIsNone(old1)
        self.assertTrue(new1)
        old2, new2 = co.set_trust(path, False, user_json_path=self.claude_json)
        self.assertTrue(old2)
        self.assertFalse(new2)

    def test_no_op_returns_same_old_new(self):
        path = os.path.realpath("/path")
        write_json(self.claude_json, {"projects": {path: {"hasTrustDialogAccepted": True}}})
        old, new = co.set_trust(path, True, user_json_path=self.claude_json)
        self.assertEqual((old, new), (True, True))

    def test_raises_value_error_on_non_dict_projects(self):
        write_json(self.claude_json, {"projects": []})
        bytes_before = read_bytes(self.claude_json)
        path = os.path.realpath("/path")
        with self.assertRaises(ValueError):
            co.set_trust(path, True, user_json_path=self.claude_json)
        bytes_after = read_bytes(self.claude_json)
        self.assertEqual(bytes_before, bytes_after)

    def test_raises_value_error_on_non_dict_entry(self):
        path = os.path.realpath("/path")
        write_json(self.claude_json, {"projects": {path: "x"}})
        bytes_before = read_bytes(self.claude_json)
        with self.assertRaises(ValueError):
            co.set_trust(path, True, user_json_path=self.claude_json)
        bytes_after = read_bytes(self.claude_json)
        self.assertEqual(bytes_before, bytes_after)


class TrustTabRowTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.old_path = co.CLAUDE_JSON_PATH
        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_non_global_empty_file_current_no_entry(self):
        write_json(self.claude_json, {})
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)
        entries = co.build_trust_entries(trust_key, False, cwd=cwd,
                                         user_json_path=self.claude_json)
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertTrue(e["current"])
        self.assertFalse(e["has_entry"])
        self.assertFalse(e["trusted"])
        rows = co.build_rows(entries, set())
        self.assertEqual(rows, [("trust", 0, None)])

    def test_non_global_ignores_other_entries(self):
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)
        other = os.path.realpath(os.path.join(self.tmpdir, "other"))
        write_json(self.claude_json, {"projects": {
            other: {"hasTrustDialogAccepted": True}}})
        entries = co.build_trust_entries(trust_key, False, cwd=cwd,
                                         user_json_path=self.claude_json)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["path"], trust_key)

    def test_global_lists_all_entries_one_current(self):
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)   # no .git -> == cwd
        paths = [trust_key,
                os.path.realpath(os.path.join(self.tmpdir, "z")),
                os.path.realpath(os.path.join(self.tmpdir, "a"))]
        write_json(self.claude_json, {"projects": {
            p: {"hasTrustDialogAccepted": False} for p in paths}})
        entries = co.build_trust_entries(trust_key, True, cwd=cwd,
                                         user_json_path=self.claude_json)
        self.assertEqual([e["path"] for e in entries], sorted(paths))
        self.assertEqual(sum(1 for e in entries if e["current"]), 1)

    def test_global_adds_current_when_absent(self):
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)
        other1 = os.path.realpath(os.path.join(self.tmpdir, "aaa"))
        other2 = os.path.realpath(os.path.join(self.tmpdir, "zzz"))
        write_json(self.claude_json, {"projects": {
            other1: {"hasTrustDialogAccepted": True},
            other2: {"hasTrustDialogAccepted": False},
        }})
        entries = co.build_trust_entries(trust_key, True, cwd=cwd,
                                         user_json_path=self.claude_json)
        paths = [e["path"] for e in entries]
        self.assertEqual(paths, sorted([other1, other2, trust_key]))
        current = next(e for e in entries if e["current"])
        self.assertEqual(current["path"], trust_key)
        self.assertFalse(current["has_entry"])
        self.assertFalse(current["flag_set"])

    def test_global_build_rows_collapsed_and_expanded(self):
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)
        onboarded = os.path.realpath(os.path.join(self.tmpdir, "aaa"))
        plain = os.path.realpath(os.path.join(self.tmpdir, "zzz"))
        write_json(self.claude_json, {"projects": {
            onboarded: {"hasTrustDialogAccepted": True,
                        "projectOnboardingSeenCount": 2},
            plain: {"hasTrustDialogAccepted": False},
        }})
        entries = co.build_trust_entries(trust_key, True, cwd=cwd,
                                         user_json_path=self.claude_json)
        self.assertEqual(co.build_rows(entries, set()),
                         [("trust", i, None) for i in range(len(entries))])
        idx = {e["path"]: i for i, e in enumerate(entries)}
        rows = co.build_rows(entries, {e["key"] for e in entries})
        kinds = {i: [r[0] for r in rows if r[1] == i] for i in idx.values()}
        self.assertEqual(kinds[idx[onboarded]], ["trust", "trust-detail"])
        self.assertEqual(kinds[idx[plain]], ["trust", "empty"])
        self.assertEqual(kinds[idx[trust_key]], ["trust", "empty"])

    def test_flag_set_distinguishes_false_from_absent(self):
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)
        other = os.path.realpath(os.path.join(self.tmpdir, "other"))
        write_json(self.claude_json, {"projects": {
            trust_key: {"hasTrustDialogAccepted": False},
            other: {"allowedTools": []},
        }})
        entries = co.build_trust_entries(trust_key, True, cwd=cwd,
                                         user_json_path=self.claude_json)
        flags = {e["path"]: e["flag_set"] for e in entries}
        self.assertEqual(flags, {trust_key: True, other: False})

    def test_expanded_with_onboarding_fields(self):
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)
        write_json(self.claude_json, {"projects": {trust_key: {
            "hasTrustDialogAccepted": True,
            "projectOnboardingSeenCount": 5,
            "hasCompletedProjectOnboarding": True,
        }}})
        entries = co.build_trust_entries(trust_key, False, cwd=cwd,
                                         user_json_path=self.claude_json)
        rows = co.build_rows(entries, {entries[0]["key"]})
        self.assertEqual([r[0] for r in rows], ["trust", "trust-detail", "trust-detail"])
        texts = [r[2] for r in rows[1:]]
        self.assertTrue(any("5" in t for t in texts))
        self.assertTrue(any("True" in t for t in texts))

    def test_expanded_without_onboarding_fields(self):
        cwd = os.path.realpath(self.tmpdir)
        trust_key = co.resolve_trust_key(cwd)
        write_json(self.claude_json, {"projects": {
            trust_key: {"hasTrustDialogAccepted": True}}})
        entries = co.build_trust_entries(trust_key, False, cwd=cwd,
                                         user_json_path=self.claude_json)
        rows = co.build_rows(entries, {entries[0]["key"]})
        self.assertEqual([r[0] for r in rows], ["trust", "empty"])

    def test_suppressor_detail_when_untrusted(self):
        repo = os.path.join(self.tmpdir, "repo")
        os.makedirs(os.path.join(repo, ".git"))
        sub = os.path.join(repo, "sub")
        os.makedirs(sub)
        repo_real = os.path.realpath(repo)
        sub_real = os.path.realpath(sub)
        write_json(self.claude_json, {"projects": {
            sub_real: {"hasTrustDialogAccepted": True},
        }})
        trust_key = co.resolve_trust_key(repo_real)
        entries = co.build_trust_entries(trust_key, False, cwd=sub_real,
                                         user_json_path=self.claude_json)
        e = entries[0]
        self.assertFalse(e["trusted"])
        self.assertEqual(e["suppressor"], sub_real)
        self.assertIn(("suppressed by", sub_real), e["detail_items"])

    def test_no_suppressor_detail_when_trusted(self):
        repo = os.path.join(self.tmpdir, "repo2")
        os.makedirs(os.path.join(repo, ".git"))
        repo_real = os.path.realpath(repo)
        write_json(self.claude_json, {"projects": {
            repo_real: {"hasTrustDialogAccepted": True}}})
        trust_key = co.resolve_trust_key(repo_real)
        entries = co.build_trust_entries(trust_key, False, cwd=repo_real,
                                         user_json_path=self.claude_json)
        e = entries[0]
        self.assertTrue(e["trusted"])
        self.assertIsNone(e["suppressor"])
        self.assertNotIn("suppressed by", [label for label, _ in e["detail_items"]])


class TrustConfirmLabelTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_path = co.CLAUDE_JSON_PATH
        co.CLAUDE_JSON_PATH = os.path.join(self.tempdir.name, ".claude.json")

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_plugin_label(self):
        entry = {"name": "p", "marketplace": "m"}
        self.assertEqual(co.confirm_prompt("plugin", entry), ("Delete", "p@m"))

    def test_trusted_entry_label(self):
        entry = {"path": "/x", "trusted": True}
        self.assertEqual(co.confirm_prompt("trust", entry), ("Untrust", "/x"))

    def test_untrusted_or_unset_label_trusts(self):
        for flag_set in (True, False):
            entry = {"path": "/x", "trusted": False, "flag_set": flag_set}
            self.assertEqual(co.confirm_prompt("trust", entry), ("Trust", "/x"))


class TrustToggleTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_path = co.CLAUDE_JSON_PATH
        co.CLAUDE_JSON_PATH = os.path.join(self.tempdir.name, ".claude.json")

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_trusted_clears_flag(self):
        self.assertIsNone(co.trust_next_state({"trusted": True, "flag_set": True}))

    def test_untrusted_and_unset_become_trusted(self):
        self.assertIs(co.trust_next_state({"trusted": False, "flag_set": True}), True)
        self.assertIs(co.trust_next_state({"trusted": False, "flag_set": False}), True)


class TrustTabSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_path = co.CLAUDE_JSON_PATH
        co.CLAUDE_JSON_PATH = os.path.join(self.tempdir.name, ".claude.json")

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_mixed_counts(self):
        entries = [{"trusted": True}, {"trusted": False}, {"trusted": False}]
        summary = co.trust_tab_summary(entries)
        self.assertEqual(summary, {"total": 3, "trusted": 1, "untrusted": 2})

    def test_no_entry_counts_as_untrusted(self):
        entries = [{"trusted": True}, {"trusted": False, "has_entry": False}]
        summary = co.trust_tab_summary(entries)
        self.assertEqual(summary["untrusted"], 1)


class TrustConfirmActionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.old_path = co.CLAUDE_JSON_PATH
        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json

    def tearDown(self):
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def test_success_flips_flag_and_returns_saved(self):
        path = os.path.realpath(os.path.join(self.tmpdir, "repo"))
        write_json(self.claude_json, {"projects": {
            path: {"allowedTools": []}}})
        entry = {"path": path, "trusted": False, "flag_set": False}
        ok, msg = co.apply_trust_confirm(entry, user_json_path=self.claude_json)
        self.assertTrue(ok)
        self.assertEqual(msg, "saved")
        doc = load_doc(self.claude_json)
        self.assertTrue(doc["projects"][path]["hasTrustDialogAccepted"])

    def test_trusted_flag_is_cleared(self):
        path = os.path.realpath(os.path.join(self.tmpdir, "repo"))
        write_json(self.claude_json, {"projects": {
            path: {"hasTrustDialogAccepted": True, "allowedTools": ["x"]}}})
        entry = {"path": path, "trusted": True, "flag_set": True}
        ok, _ = co.apply_trust_confirm(entry, user_json_path=self.claude_json)
        self.assertTrue(ok)
        doc = load_doc(self.claude_json)
        self.assertEqual(doc["projects"][path], {"allowedTools": ["x"]})

    def test_malformed_file_returns_error_and_untouched(self):
        with open(self.claude_json, "w") as f:
            f.write("{invalid")
        entry = {"path": "/x", "trusted": False}
        bytes_before = read_bytes(self.claude_json)
        ok, msg = co.apply_trust_confirm(entry, user_json_path=self.claude_json)
        self.assertFalse(ok)
        self.assertTrue(msg.startswith("error:"))
        bytes_after = read_bytes(self.claude_json)
        self.assertEqual(bytes_before, bytes_after)

    def test_toggling_one_global_entry_leaves_others_unchanged(self):
        p1 = os.path.realpath(os.path.join(self.tmpdir, "p1"))
        p2 = os.path.realpath(os.path.join(self.tmpdir, "p2"))
        write_json(self.claude_json, {"projects": {
            p1: {"hasTrustDialogAccepted": True},
            p2: {"hasTrustDialogAccepted": False},
        }})
        entry = {"path": p2, "trusted": False, "flag_set": True}
        ok, _ = co.apply_trust_confirm(entry, user_json_path=self.claude_json)
        self.assertTrue(ok)
        doc = load_doc(self.claude_json)
        self.assertTrue(doc["projects"][p1]["hasTrustDialogAccepted"])
        self.assertTrue(doc["projects"][p2]["hasTrustDialogAccepted"])


class TrustCliTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.tmpdir = self.tempdir.name
        self.old_cwd = os.getcwd()
        self.old_path = co.CLAUDE_JSON_PATH

        # Create a temp repo with .git
        self.repo = os.path.join(self.tmpdir, "repo")
        os.makedirs(os.path.join(self.repo, ".git"))
        os.chdir(self.repo)

        self.claude_json = os.path.join(self.tmpdir, ".claude.json")
        co.CLAUDE_JSON_PATH = self.claude_json
        write_json(self.claude_json, {})

    def tearDown(self):
        os.chdir(self.old_cwd)
        co.CLAUDE_JSON_PATH = self.old_path
        self.tempdir.cleanup()

    def _run_cli(self, argv):
        """Run main() with patched sys.argv and capture stdout."""
        output = io.StringIO()
        with mock.patch.object(sys, "argv", argv):
            with contextlib.redirect_stdout(output):
                co.main()
        return output.getvalue()

    def test_trust_with_default_cwd_key(self):
        key = os.path.realpath(self.repo)
        output = self._run_cli(["prog", "--trust"])
        self.assertIn(key, output)
        self.assertIn("no entry -> trusted", output)

    def test_trust_with_explicit_path(self):
        explicit = os.path.realpath(os.path.join(self.tmpdir, "other"))
        output = self._run_cli(["prog", "--trust", explicit])
        self.assertIn(explicit, output)
        self.assertIn("no entry -> trusted", output)

    def test_untrust_after_trust(self):
        key = os.path.realpath(self.repo)
        write_json(self.claude_json, {"projects": {key: {"hasTrustDialogAccepted": True}}})
        output = self._run_cli(["prog", "--untrust"])
        self.assertIn(key, output)
        self.assertIn("trusted -> untrusted", output)

    def test_trust_status_shows_suppressor(self):
        # Create a trusted ancestor directory inside the repo tree
        key = os.path.realpath(self.repo)
        ancestor = os.path.join(self.repo, "ancestor")
        os.makedirs(ancestor, exist_ok=True)
        ancestor_real = os.path.realpath(ancestor)

        # Explicitly set the key to false (untrusted) so the suppressor check runs
        start_dir = os.path.join(ancestor, "subdir")
        os.makedirs(start_dir, exist_ok=True)
        old_cwd = os.getcwd()
        os.chdir(start_dir)
        try:
            write_json(self.claude_json, {"projects": {
                key: {"hasTrustDialogAccepted": False},
                ancestor_real: {"hasTrustDialogAccepted": True}
            }})
            output = self._run_cli(["prog", "--trust-status"])
            self.assertIn(key, output)
            self.assertIn("untrusted", output)
            self.assertIn("Dialog suppressed by trusted entry", output)
        finally:
            os.chdir(old_cwd)

    def test_trust_status_shows_suppressor_when_key_has_no_entry(self):
        key = os.path.realpath(self.repo)
        ancestor = os.path.join(self.repo, "ancestor")
        start_dir = os.path.join(ancestor, "subdir")
        os.makedirs(start_dir, exist_ok=True)
        old_cwd = os.getcwd()
        os.chdir(start_dir)
        try:
            write_json(self.claude_json, {"projects": {
                os.path.realpath(ancestor): {"hasTrustDialogAccepted": True}
            }})
            output = self._run_cli(["prog", "--trust-status"])
            self.assertIn(f"{key}: no entry", output)
            self.assertIn("Dialog suppressed by trusted entry", output)
        finally:
            os.chdir(old_cwd)

    def test_trust_status_global_lists_all(self):
        path1 = os.path.realpath(os.path.join(self.tmpdir, "p1"))
        path2 = os.path.realpath(os.path.join(self.tmpdir, "p2"))
        write_json(self.claude_json, {"projects": {
            path1: {"hasTrustDialogAccepted": True},
            path2: {"hasTrustDialogAccepted": False},
        }})
        output = self._run_cli(["prog", "--trust-status", "-g"])
        self.assertIn(path1, output)
        self.assertIn(path2, output)
        self.assertIn("trusted", output)
        self.assertIn("untrusted", output)

    def test_home_directory_warning(self):
        home = os.path.realpath(os.path.expanduser("~"))
        with mock.patch.dict(os.environ, {"HOME": home}):
            output = self._run_cli(["prog", "--trust", home])
            self.assertIn("WARNING", output)
            self.assertIn("session-only", output)

    def test_malformed_file_exits(self):
        with open(self.claude_json, "w") as f:
            f.write("{invalid")
        with self.assertRaises(SystemExit):
            self._run_cli(["prog", "--trust"])

    def test_mutually_exclusive_flags(self):
        with self.assertRaises(SystemExit):
            self._run_cli(["prog", "--trust", "--untrust"])

    def test_untrust_with_no_entry_reports_unchanged(self):
        key = os.path.realpath(self.repo)
        output = self._run_cli(["prog", "--untrust"])
        self.assertIn(f"{key}: no entry (unchanged)", output)
        self.assertNotIn("->", output)
        self.assertNotIn("Note:", output)

    def test_trust_when_already_trusted_reports_unchanged(self):
        key = os.path.realpath(self.repo)
        write_json(self.claude_json, {"projects": {key: {"hasTrustDialogAccepted": True}}})
        output = self._run_cli(["prog", "--trust"])
        self.assertIn(f"{key}: trusted (unchanged)", output)

    def test_non_dict_projects_exits_cleanly(self):
        write_json(self.claude_json, {"projects": []})
        with self.assertRaises(SystemExit) as cm:
            self._run_cli(["prog", "--trust"])
        self.assertTrue(str(cm.exception.code).startswith("claude-optin:"))
        doc = load_doc(self.claude_json)
        self.assertEqual(doc, {"projects": []})

    def test_trust_status_in_linked_worktree_reports_own_root_suppressor(self):
        root = os.path.realpath(self.tmpdir)
        main = os.path.join(root, "main")
        os.makedirs(os.path.join(main, ".git"))
        wt = os.path.join(root, "wt")
        make_worktree(main, wt)
        wt_real = os.path.realpath(wt)
        write_json(self.claude_json, {"projects": {wt_real: {"hasTrustDialogAccepted": True}}})
        old_cwd = os.getcwd()
        os.chdir(wt)
        try:
            output = self._run_cli(["prog", "--trust-status"])
            main_real = os.path.realpath(main)
            self.assertIn(f"{main_real}: no entry", output)
            self.assertIn(f"Dialog suppressed by trusted entry: {wt_real}", output)
        finally:
            os.chdir(old_cwd)


class CursorFollowTests(unittest.TestCase):
    def setUp(self):
        self._old_claude_dir = co.CLAUDE_DIR

    def tearDown(self):
        co.CLAUDE_DIR = self._old_claude_dir

    def test_find_entry_row_tracks_a_cycled_and_resorted_server(self):
        with tempfile.TemporaryDirectory() as home:
            repo = os.path.join(home, "repo")
            os.makedirs(repo)
            co.CLAUDE_DIR = os.path.join(home, ".claude")
            s = co.Settings(repo)
            s.cycle_mcp("a")   # seed "a" approved, so it sorts first

            servers = [co._mcp_entry(n, {}, "test") for n in ("a", "b", "c")]
            expanded = {"a"}

            srv = co.sort_mcp_servers(servers, s, "enabled")
            self.assertEqual([e["name"] for e in srv], ["a", "b", "c"])
            rows = co.build_rows(srv, expanded)
            c_entry_idx = next(i for i, e in enumerate(srv) if e["name"] == "c")

            s.cycle_mcp("c")   # pending -> approved

            srv2 = co.sort_mcp_servers(servers, s, "enabled")
            self.assertEqual([e["name"] for e in srv2], ["a", "c", "b"])
            rows2 = co.build_rows(srv2, expanded)
            c_entry_idx2 = next(i for i, e in enumerate(srv2) if e["name"] == "c")

            row_idx = co.find_entry_row(rows2, srv2, "c")
            self.assertIsNotNone(row_idx)
            self.assertEqual(srv2[rows2[row_idx][1]]["name"], "c")
            self.assertNotEqual(row_idx, c_entry_idx2)
            self.assertNotEqual(c_entry_idx, c_entry_idx2)  # sanity: position moved

            self.assertIsNone(co.find_entry_row(rows2, srv2, "no-such-key"))


class SettingsRootTests(unittest.TestCase):
    def test_git_root_wins_over_nested_claude_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = os.path.realpath(tmpdir)
            repo = os.path.join(root, "repo")
            os.makedirs(os.path.join(repo, ".git"))
            deeper = os.path.join(repo, "sub", "deeper")
            os.makedirs(os.path.join(repo, "sub", ".claude"))
            os.makedirs(deeper)
            self.assertEqual(co.settings_root(deeper), os.path.realpath(repo))

    def test_no_git_falls_back_to_start_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = os.path.realpath(tmpdir)
            top = os.path.join(root, "top")
            child = os.path.join(top, "child")
            os.makedirs(os.path.join(top, ".claude"))
            os.makedirs(child)
            self.assertEqual(co.settings_root(child), os.path.realpath(child))

    def test_linked_worktree_settings_root_differs_from_trust_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = os.path.realpath(tmpdir)
            main = os.path.join(root, "main")
            os.makedirs(os.path.join(main, ".git"))
            wt = os.path.join(root, "wt")
            make_worktree(main, wt)
            sub = os.path.join(wt, "sub")
            os.makedirs(sub)
            self.assertEqual(co.settings_root(sub), os.path.realpath(wt))
            self.assertEqual(co.resolve_trust_key(sub), main)


class MainWiringTests(unittest.TestCase):
    def setUp(self):
        self._old_claude_dir = co.CLAUDE_DIR
        self._old_claude_json = co.CLAUDE_JSON_PATH

    def tearDown(self):
        co.CLAUDE_DIR = self._old_claude_dir
        co.CLAUDE_JSON_PATH = self._old_claude_json

    def test_main_wires_settings_root_repo_root_and_trust(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = os.path.realpath(tmpdir)
            repo = os.path.join(root, "repo")
            os.makedirs(os.path.join(repo, ".git"))
            sub = os.path.join(repo, "sub")
            os.makedirs(os.path.join(sub, ".claude"))
            co.CLAUDE_DIR = os.path.join(root, "home-claude")
            co.CLAUDE_JSON_PATH = os.path.join(root, "home-claude.json")
            write_json(co.CLAUDE_JSON_PATH,
                       {"projects": {repo: {"hasTrustDialogAccepted": True}}})

            captured = {}

            def fake_wrapper(func, *args):
                captured["settings"] = args[3]
                return None

            def fake_discover_skills(*args, **kwargs):
                captured["discover_skills_args"] = args
                return []

            old_cwd = os.getcwd()
            os.chdir(sub)
            try:
                with mock.patch.object(sys, "argv", ["claude-optins"]), \
                     mock.patch.object(co.curses, "wrapper", fake_wrapper), \
                     mock.patch.object(co, "discover_plugins", return_value=[]), \
                     mock.patch.object(co, "discover_skills", fake_discover_skills), \
                     contextlib.redirect_stdout(io.StringIO()):
                    co.main()
            finally:
                os.chdir(old_cwd)

            self.assertEqual(captured["settings"].repo_root, os.path.realpath(repo))
            self.assertEqual(captured["discover_skills_args"][1], sub)
            self.assertTrue(captured["settings"].trusted)


if __name__ == "__main__":
    unittest.main(verbosity=2)
