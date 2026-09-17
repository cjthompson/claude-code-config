import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = join(ROOT, "packages/installer/src/lib");

const { installPackage, removePackage } = await import(join(SRC, "install.ts"));
const {
    parsePluginList,
    parseMarketplaceList,
    compareVersions,
    pluginInstallArgv,
    INSTALL_SCOPE,
} = await import(join(SRC, "plugin-cli.ts"));

const MARKETPLACE = "cjthompson-claude-code-config";
const PLUGIN_ID = `output-styles@${MARKETPLACE}`;

/** A Spawn that records argv and replies from a prefix-matched table. */
function recorder(replies = []) {
    const calls = [];
    const spawn = async (bin, argv) => {
        calls.push(argv.join(" "));
        for (const [prefix, reply] of replies) {
            if (argv.join(" ").startsWith(prefix)) {
                if (reply instanceof Error) throw reply;
                return reply;
            }
        }
        return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, spawn };
}

function ok(stdout = "") {
    return { code: 0, stdout, stderr: "" };
}

function marketplaceReply(names = [MARKETPLACE]) {
    return ok(JSON.stringify(names.map((name) => ({ name, source: "github" }))));
}

function listReply(rows) {
    return ok(JSON.stringify(rows));
}

function descriptor({ version = "1.0.1", enabled = true, markedForRemoval = false } = {}) {
    return {
        id: "plugin:output-styles",
        label: "output-styles",
        description: "",
        type: "plugin",
        enabled: true,
        packageDir: join(ROOT, "plugins/output-styles"),
        manifest: { label: "output-styles", description: "", type: "skills" },
        marketplaceName: MARKETPLACE,
        marketplaceSource: "cjthompson/claude-code-config",
        items: [
            {
                name: "output-styles",
                enabled,
                alreadyInstalled: false,
                markedForRemoval,
                itemType: "plugin",
                pluginId: PLUGIN_ID,
                pluginVersion: version,
            },
        ],
    };
}

function enoent() {
    const err = new Error("spawn claude ENOENT");
    err.code = "ENOENT";
    return err;
}

test("installs with the verified argv: plugin install <id> --scope user --yes --json", async () => {
    const { calls, spawn } = recorder([
        ["plugin marketplace list", marketplaceReply()],
        ["plugin list", listReply([])],
    ]);

    const results = await installPackage(descriptor(), spawn);

    assert.ok(
        calls.includes(`plugin install ${PLUGIN_ID} --scope user --yes --json`),
        `expected the install argv, got:\n${calls.join("\n")}`,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "created");
    // The whole point of the change: the CLI installs, nothing is copied.
    assert.match(results[0].message, /Installed: output-styles@/);
});

test("pluginInstallArgv is the single source of the command string", () => {
    assert.deepEqual(pluginInstallArgv(PLUGIN_ID), [
        "plugin",
        "install",
        PLUGIN_ID,
        "--scope",
        INSTALL_SCOPE,
        "--yes",
        "--json",
    ]);
    assert.equal(INSTALL_SCOPE, "user");
});

test("idempotent: a plugin already at the declared version runs no install command", async () => {
    const { calls, spawn } = recorder([
        ["plugin marketplace list", marketplaceReply()],
        [
            "plugin list",
            listReply([
                { id: PLUGIN_ID, version: "1.0.1", scope: "user", enabled: true },
            ]),
        ],
    ]);

    const results = await installPackage(descriptor({ version: "1.0.1" }), spawn);

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "already-exists");
    assert.ok(
        !calls.some((c) => c.startsWith("plugin install")),
        `expected zero install spawns, got:\n${calls.join("\n")}`,
    );
    assert.ok(
        !calls.some((c) => c.startsWith("plugin update")),
        "expected zero update spawns",
    );
});

test("upgrade: an older installed version triggers plugin update, not install", async () => {
    const { calls, spawn } = recorder([
        ["plugin marketplace list", marketplaceReply()],
        [
            "plugin list",
            listReply([
                { id: PLUGIN_ID, version: "1.0.0", scope: "user", enabled: true },
            ]),
        ],
    ]);

    const results = await installPackage(descriptor({ version: "1.0.1" }), spawn);

    assert.equal(results[0].status, "updated");
    assert.ok(calls.some((c) => c.startsWith(`plugin update ${PLUGIN_ID}`)));
    assert.ok(!calls.some((c) => c.startsWith("plugin install")));
});

test("parsePluginList filters to the install scope and dedupes repeated ids", () => {
    // The real shape: same id at two scopes, and twice at one scope.
    const stdout = JSON.stringify([
        { id: "command-watchdog@m", version: "1.3.0", scope: "user", enabled: true },
        { id: "command-watchdog@m", version: "1.0.1", scope: "local", enabled: true },
        { id: "rust-coding@m", version: "1.0.1", scope: "local", enabled: false },
        { id: "rust-coding@m", version: "1.0.1", scope: "local", enabled: false },
        { id: "output-styles@m", version: "1.0.1", scope: "user", enabled: true },
    ]);

    const byId = parsePluginList(stdout);

    assert.equal(byId.size, 2, "only user-scope entries survive");
    assert.equal(byId.get("command-watchdog@m").version, "1.3.0");
    assert.equal(byId.get("command-watchdog@m").scope, "user");
    assert.ok(!byId.has("rust-coding@m"), "local-scope-only ids are excluded");

    // Highest version wins when one scope lists an id twice.
    const dupes = parsePluginList(
        JSON.stringify([
            { id: "a@m", version: "1.0.0", scope: "user", enabled: true },
            { id: "a@m", version: "2.1.0", scope: "user", enabled: true },
        ]),
    );
    assert.equal(dupes.size, 1);
    assert.equal(dupes.get("a@m").version, "2.1.0");
});

test("parsePluginList and parseMarketplaceList tolerate garbage without throwing", () => {
    assert.equal(parsePluginList("not json").size, 0);
    assert.equal(parsePluginList("").size, 0);
    assert.equal(parseMarketplaceList("{{{").size, 0);
    assert.equal(parseMarketplaceList(JSON.stringify([{ nope: 1 }])).size, 0);
});

test("compareVersions orders numerically, not lexically", () => {
    assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
    assert.ok(compareVersions("1.0.1", "1.0.1") === 0);
    assert.ok(compareVersions("1.0.0", "1.1.0") < 0);
    assert.ok(compareVersions("2", "1.9.9") > 0);
});

test("missing claude binary reports recovery commands and copies NOTHING", async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "claude-dir-"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = fixture;
    t.after(async () => {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
        await rm(fixture, { recursive: true, force: true });
    });

    const { calls, spawn } = recorder([["--version", enoent()]]);
    const results = await installPackage(descriptor(), spawn);

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "error");
    assert.match(results[0].message, /claude CLI not found on PATH/);
    assert.match(results[0].message, /\/plugin marketplace add cjthompson\/claude-code-config/);
    assert.match(results[0].message, new RegExp(`/plugin install ${PLUGIN_ID}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // The regression guard: no fallback copy, so the fixture claudeDir stays empty.
    assert.deepEqual(
        await readdir(fixture),
        [],
        "installPlugin must never write into ~/.claude/ — a copy fallback recreates the duplicate-name bug",
    );
    assert.ok(
        !calls.some((c) => c.startsWith("plugin install")),
        "must not attempt an install once the binary is known missing",
    );
});

test("unregistered marketplace errors out and never auto-runs marketplace add", async () => {
    const { calls, spawn } = recorder([
        ["plugin marketplace list", marketplaceReply(["some-other-marketplace"])],
        ["plugin list", listReply([])],
    ]);

    const results = await installPackage(descriptor(), spawn);

    assert.equal(results[0].status, "error");
    assert.match(results[0].message, /is not registered/);
    assert.match(results[0].message, /marketplace add cjthompson\/claude-code-config/);
    assert.ok(
        !calls.some((c) => c.startsWith("plugin marketplace add")),
        "re-binding an already-registered marketplace name would clobber a working entry",
    );
    assert.ok(!calls.some((c) => c.startsWith("plugin install")));
});

test("installed-but-disabled is reported with the enable command, never auto-enabled", async () => {
    const { calls, spawn } = recorder([
        ["plugin marketplace list", marketplaceReply()],
        [
            "plugin list",
            listReply([
                { id: PLUGIN_ID, version: "1.0.1", scope: "user", enabled: false },
            ]),
        ],
    ]);

    const results = await installPackage(descriptor({ version: "1.0.1" }), spawn);

    assert.equal(results[0].status, "already-exists");
    assert.match(results[0].message, /disabled/);
    assert.match(results[0].message, new RegExp(`claude plugin enable ${PLUGIN_ID}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(
        !calls.some((c) => c.startsWith("plugin enable")),
        "enabling is a user preference the installer did not set",
    );
});

test("a non-zero CLI exit surfaces the --json failure message", async () => {
    const failure = JSON.stringify({
        command: "install",
        outcome: "failed",
        message: 'Plugin "output-styles" not found in marketplace',
        failureCode: "not_found",
    });
    const { spawn } = recorder([
        ["plugin marketplace list", marketplaceReply()],
        ["plugin list", listReply([])],
        ["plugin install", { code: 1, stdout: failure, stderr: "" }],
    ]);

    const results = await installPackage(descriptor(), spawn);

    assert.equal(results[0].status, "error");
    assert.match(results[0].message, /not found in marketplace/);
    assert.match(results[0].message, /not_found/);
});

test("discovery derives plugin ids and marketplace source from the manifest", async () => {
    const { discoverPackages } = await import(join(SRC, "discover.ts"));
    // No CLI available: discovery must still produce descriptors.
    const packages = await discoverPackages(ROOT, async () => {
        throw enoent();
    });

    const styles = packages.find((p) => p.id === "plugin:output-styles");
    assert.ok(styles, "output-styles must be discoverable without a manifest.json");
    assert.equal(styles.type, "plugin");
    assert.equal(styles.marketplaceName, MARKETPLACE);

    // Regression: source was once built from repoRoot's basename, which in a git
    // worktree is the branch name — printing a repo that does not exist.
    assert.equal(styles.marketplaceSource, "cjthompson/claude-code-config");
    assert.ok(
        !styles.marketplaceSource.includes(ROOT.split("/").pop()),
        "marketplace source must not leak the checkout directory name",
    );

    assert.equal(styles.items.length, 1, "a plugin is one atomic item");
    const [item] = styles.items;
    assert.equal(item.itemType, "plugin");
    assert.equal(item.pluginId, PLUGIN_ID);
    // Version comes from marketplace.json; plugin.json omits it for most plugins.
    assert.equal(item.pluginVersion, "1.0.1");
});

test("every plugin descriptor carries exactly one installable plugin item", async () => {
    const { discoverPackages } = await import(join(SRC, "discover.ts"));
    const packages = await discoverPackages(ROOT, async () => {
        throw enoent();
    });
    const plugins = packages.filter((p) => p.type === "plugin");

    assert.ok(plugins.length >= 11, `expected all plugins discovered, got ${plugins.length}`);
    for (const pkg of plugins) {
        assert.equal(pkg.items.length, 1, `${pkg.id} must emit one item`);
        assert.equal(pkg.items[0].itemType, "plugin", `${pkg.id} item must be a plugin`);
        assert.ok(pkg.items[0].pluginId, `${pkg.id} must have a plugin id`);
        // No skill/file/agent items: those are what got copied into ~/.claude/.
        assert.ok(
            !pkg.items.some((i) => ["skill", "file", "agent"].includes(i.itemType)),
            `${pkg.id} must not emit copyable items`,
        );
    }
});

test("removal uninstalls through the CLI", async () => {
    const { calls, spawn } = recorder([]);
    const pkg = descriptor({ markedForRemoval: true });

    const results = await removePackage(pkg, spawn);

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "removed");
    assert.ok(calls.some((c) => c.startsWith(`plugin uninstall ${PLUGIN_ID}`)));
});
