import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = join(ROOT, "plugins/command-watchdog");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("Claude and Codex expose the same watchdog and hook", async () => {
    const claude = await readJson(join(PLUGIN, ".claude-plugin/plugin.json"));
    const codex = await readJson(join(PLUGIN, ".codex-plugin/plugin.json"));
    assert.equal(codex.name, claude.name);
    assert.equal(codex.version, claude.version);
    assert.equal(codex.hooks, "./hooks/hooks.json");
    const hooks = await readJson(join(PLUGIN, codex.hooks));
    assert.equal(hooks.hooks.PreToolUse.length, 1);
    const [{ matcher, hooks: handlers }] = hooks.hooks.PreToolUse;
    assert.ok(new RegExp(matcher).test("Bash"));
    assert.equal(handlers.length, 1);
    assert.equal(handlers[0].type, "command");
    assert.match(handlers[0].command, /CLAUDE_PLUGIN_ROOT.*hooks\/bash-watchdog\.py/);
    assert.equal((await stat(join(PLUGIN, "hooks/bash-watchdog.py"))).isFile(), true);
});

test("both marketplaces register the shared watchdog directory", async () => {
    const manifest = await readJson(join(PLUGIN, ".codex-plugin/plugin.json"));
    const claude = await readJson(join(ROOT, ".claude-plugin/marketplace.json"));
    const codex = await readJson(join(ROOT, ".agents/plugins/marketplace.json"));
    const claudeEntry = claude.plugins.find(({ name }) => name === manifest.name);
    const codexEntry = codex.plugins.find(({ name }) => name === manifest.name);
    assert.ok(claudeEntry);
    assert.ok(codexEntry);
    assert.equal(claudeEntry.version, manifest.version);
    assert.equal(claudeEntry.source, "./plugins/command-watchdog");
    assert.deepEqual(codexEntry.source, { source: "local", path: claudeEntry.source });
});
