import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = join(ROOT, "plugins/worktree-guard");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("Claude and Codex manifests share name, version, and hooks", async () => {
    const claude = await readJson(join(PLUGIN, ".claude-plugin/plugin.json"));
    const codex = await readJson(join(PLUGIN, ".codex-plugin/plugin.json"));
    assert.equal(codex.name, claude.name);
    assert.equal(codex.version, claude.version);
    assert.equal(codex.hooks, "./hooks/hooks.json");
    const { hooks } = await readJson(join(PLUGIN, codex.hooks));
    const [pre] = hooks.PreToolUse;
    for (const tool of ["Edit", "Write", "NotebookEdit", "apply_patch"]) {
        assert.ok(pre.matcher.split("|").includes(tool), `matcher covers ${tool}`);
    }
    assert.match(pre.hooks[0].command, /CLAUDE_PLUGIN_ROOT.*hooks\/worktree-guard\.py" pre-tool-use$/);
    assert.match(hooks.SessionStart[0].hooks[0].command, /hooks\/worktree-guard\.py" session-start$/);
    for (const file of ["worktree-guard.py", "worktree-rule.md"]) {
        assert.equal((await stat(join(PLUGIN, "hooks", file))).isFile(), true);
    }
});

test("Claude and Codex marketplaces register worktree-guard; Cursor does not", async () => {
    const manifest = await readJson(join(PLUGIN, ".claude-plugin/plugin.json"));
    const claude = await readJson(join(ROOT, ".claude-plugin/marketplace.json"));
    const codex = await readJson(join(ROOT, ".agents/plugins/marketplace.json"));
    const cursor = await readJson(join(ROOT, ".cursor-plugin/marketplace.json"));
    const claudeEntry = claude.plugins.find(({ name }) => name === manifest.name);
    const codexEntry = codex.plugins.find(({ name }) => name === manifest.name);
    assert.equal(claudeEntry.version, manifest.version);
    assert.equal(claudeEntry.source, "./plugins/worktree-guard");
    assert.deepEqual(codexEntry.source, { source: "local", path: claudeEntry.source });
    assert.equal(cursor.plugins.some(({ name }) => name === manifest.name), false);
});
