import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGINS = join(ROOT, "plugins");
const SRC = join(ROOT, "packages/installer/src");

async function pluginDirs() {
    const entries = await readdir(PLUGINS, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

test("no plugin declares an installer manifest.json", async () => {
    const offenders = [];
    for (const name of await pluginDirs()) {
        if (await exists(join(PLUGINS, name, "manifest.json"))) offenders.push(name);
    }

    assert.deepEqual(
        offenders,
        [],
        "plugins/*/manifest.json reintroduces the file-copy route, which publishes a " +
            "plugin's assets a second time under unprefixed names. Plugin metadata " +
            "belongs in .claude-plugin/plugin.json and .claude-plugin/marketplace.json.",
    );
});

test("every plugin is discoverable by .claude-plugin/plugin.json", async () => {
    // Discovery gates on plugin.json, so a plugin missing it silently disappears
    // from `npm run install-package <name>`.
    for (const name of await pluginDirs()) {
        assert.ok(
            await exists(join(PLUGINS, name, ".claude-plugin", "plugin.json")),
            `plugins/${name} has no .claude-plugin/plugin.json and would not be discovered`,
        );
    }
});

test("output-styles ships its styles only through the plugin, not a copy list", async () => {
    const styles = await readdir(join(PLUGINS, "output-styles", "output-styles"));
    assert.ok(styles.includes("terse.md"));
    assert.ok(styles.includes("concise.md"));
    assert.ok(!(await exists(join(PLUGINS, "output-styles", "manifest.json"))));
});

test("the plugin CLI command lives in exactly one module", async () => {
    // plugin-cli.ts owns the argv. Other modules may use the "plugin" string as
    // a PackageDescriptor type discriminator, but must not build a command.
    const files = [];
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith(".ts")) files.push(full);
        }
    }
    await walk(SRC);

    const offenders = [];
    for (const file of files) {
        if (file.endsWith("lib/plugin-cli.ts")) continue;
        const text = await readFile(file, "utf8");
        // An argv array always pairs the namespace with a subcommand literal.
        if (/"plugin",\s*"(install|update|uninstall|list|marketplace|enable|disable)"/.test(text)) {
            offenders.push(file.slice(ROOT.length + 1));
        }
    }

    assert.deepEqual(offenders, [], "CLI argv must only be constructed in lib/plugin-cli.ts");
});

test("no module copies plugin files into the Claude config dir", async () => {
    // installPlugin used to copyFile/symlink plugin assets into ~/.claude/.
    // That is the duplicate-identifier bug; assert the calls are gone from it.
    const install = await readFile(join(SRC, "lib/install.ts"), "utf8");
    const pluginFn = install.slice(
        install.indexOf("async function installPlugin"),
        install.indexOf("async function removePlugin"),
    );

    assert.ok(pluginFn.length > 0, "installPlugin must exist");
    for (const banned of ["copyFile", "symlink", "mkdir"]) {
        assert.ok(
            !pluginFn.includes(banned),
            `installPlugin must not call ${banned} — plugins install via the CLI only`,
        );
    }
});
