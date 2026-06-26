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


def load_doc(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    unittest.main(verbosity=2)
