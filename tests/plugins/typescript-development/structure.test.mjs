import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = join(ROOT, "plugins/typescript-development");
const EXPECTED_SKILLS = [
    "dignified-typescript",
    "tighten-typescript-types",
    "typescript-modules-packaging",
    "typescript-project-tooling",
    "typescript-testing",
    "typescript-type-system-reference",
];


async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}


async function assertFile(path) {
    assert.equal((await stat(path)).isFile(), true, `${path} must be a file`);
}


test("cross-host manifests expose the same TypeScript development plugin", async () => {
    const claude = await readJson(join(PLUGIN, ".claude-plugin/plugin.json"));
    const codex = await readJson(join(PLUGIN, ".codex-plugin/plugin.json"));
    const cursor = await readJson(join(PLUGIN, ".cursor-plugin/plugin.json"));

    assert.equal(claude.name, "typescript-development");
    assert.equal("version" in claude, false);
    for (const manifest of [codex, cursor]) {
        assert.equal(manifest.name, "typescript-development");
        assert.equal(manifest.version, "1.0.0");
        assert.equal(manifest.skills, "./skills/");
    }
    assert.deepEqual(codex.interface.capabilities, [
        "Code",
        "Testing",
        "Type System",
        "Tooling",
        "Packaging",
    ]);
    assert.equal(codex.interface.defaultPrompt.length, 3);
});


test("plugin contains exactly the six approved model-unpinned skills", async () => {
    for (const skill of EXPECTED_SKILLS) {
        const path = join(PLUGIN, "skills", skill, "SKILL.md");
        await assertFile(path);
        const contents = await readFile(path, "utf8");
        const frontmatter = contents.split("---", 3)[1];
        assert.match(frontmatter, new RegExp(`\\nname: ${skill}\\n`));
        assert.match(frontmatter, /\ndescription: Use when/);
        assert.doesNotMatch(frontmatter, /\nmodel:/);
    }

    const { readdir } = await import("node:fs/promises");
    const actual = (await readdir(join(PLUGIN, "skills"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    assert.deepEqual(actual, EXPECTED_SKILLS);
});


test("plugin registers in Claude and Codex marketplaces", async () => {
    const claude = await readJson(join(ROOT, ".claude-plugin/marketplace.json"));
    const claudeEntry = claude.plugins.find(({ name }) => name === "typescript-development");
    assert.deepEqual(claudeEntry, {
        name: "typescript-development",
        source: "./plugins/typescript-development",
        description: "Deep TypeScript production guidance for testing, tooling, modules, packaging, and type-system work.",
        version: "1.0.1",
        keywords: ["typescript", "testing", "tooling", "modules", "typing", "packaging", "lsp"],
        category: "development",
    });

    const codex = await readJson(join(ROOT, ".agents/plugins/marketplace.json"));
    const codexEntry = codex.plugins.find(({ name }) => name === "typescript-development");
    assert.deepEqual(codexEntry, {
        name: "typescript-development",
        source: { source: "local", path: "./plugins/typescript-development" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Development",
    });
});


test("plugin exposes a TypeScript 7 LSP via .lsp.json but no other runtime components", async () => {
    const { access } = await import("node:fs/promises");
    await assertFile(join(PLUGIN, ".lsp.json"));
    for (const path of [".mcp.json", ".app.json", "agents", "hooks"]) {
        await assert.rejects(access(join(PLUGIN, path)));
    }

    const codex = await readJson(join(PLUGIN, ".codex-plugin/plugin.json"));
    for (const unsupported of ["agents", "apps", "hooks", "mcpServers"]) {
        assert.equal(unsupported in codex, false);
    }
});


test("vendored reference manifest uses one immutable official source", async () => {
    const manifest = await readJson(join(PLUGIN, "vendor/upstreams.json"));
    assert.equal(manifest.version, 1);
    assert.deepEqual(Object.keys(manifest.sources), ["microsoft/TypeScript-Website"]);
    const source = manifest.sources["microsoft/TypeScript-Website"];
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.equal(source.ref, source.commit);
    assert.equal(source.license, "CC-BY-4.0");
    assert.ok(Object.keys(manifest.files).length >= 25);
    assert.equal(
        Object.keys(manifest.files).every((path) => path.startsWith("typescript-website/") || path.startsWith("licenses/")),
        true,
    );
});
