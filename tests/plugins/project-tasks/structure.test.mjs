import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = join(ROOT, "plugins/project-tasks");


async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}


test("project-tasks manifests and marketplace entry share a version", async () => {
    const claude = await readJson(join(PLUGIN, ".claude-plugin/plugin.json"));
    const codex = await readJson(join(PLUGIN, ".codex-plugin/plugin.json"));
    const marketplace = await readJson(join(ROOT, ".claude-plugin/marketplace.json"));
    const marketplaceEntry = marketplace.plugins.find(({ name }) => name === "project-tasks");

    assert.equal(claude.name, "project-tasks");
    assert.equal(codex.name, "project-tasks");
    assert.ok(marketplaceEntry, "marketplace must register project-tasks");
    assert.equal(claude.version, codex.version);
    assert.equal(claude.version, marketplaceEntry.version);
});
