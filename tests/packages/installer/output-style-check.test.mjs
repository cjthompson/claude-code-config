import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const FIXTURES = join(HERE, "fixtures");
const MODULE_PATH = join(ROOT, "packages/installer/src/lib/output-style-check.ts");

/** Repo fixture mirroring the real plugins/output-styles/output-styles/ layout. */
const REPO = join(FIXTURES, "repo-styles");
/** Repo fixture where filename, plugin dir name, and style name all differ. */
const ODD_REPO = join(FIXTURES, "repo");

const claude = (name) => join(FIXTURES, name);

const {
    BUILTIN_STYLE_NAMES,
    allStyleNames,
    checkOutputStyle,
    configuredStyleSources,
    defaultClaudeDir,
    enumerateAvailableStyles,
    findStaleStyleCopies,
    formatVerdicts,
    listPluginStyles,
    listUserStyles,
    parseStyleName,
    readConfiguredStyles,
    runOutputStyleCheck,
    suggestStyleName,
} = await import(MODULE_PATH);

/** Availability as it looks with the real plugin set and no user-level styles. */
const AVAILABLE = {
    plugin: ["output-styles:Concise", "output-styles:Terse"],
    user: [],
    builtin: [...BUILTIN_STYLE_NAMES],
};

const configured = (value, source = "/fixture/settings.json") => [{ source, value }];
const verdict = (value, available = AVAILABLE) =>
    checkOutputStyle(configured(value), available)[0];


// --- parseStyleName ---------------------------------------------------------

test("parseStyleName takes the name from frontmatter, never the filename", async () => {
    const path = join(ODD_REPO, "plugins/fake-styles/output-styles/not-the-name.md");
    assert.equal(parseStyleName(await readFile(path, "utf8")), "FancyStyle");
});

test("parseStyleName returns null without frontmatter or a name field", () => {
    assert.equal(parseStyleName("# Just a heading\n"), null);
    assert.equal(parseStyleName("---\ndescription: no name here\n---\nbody\n"), null);
    assert.equal(parseStyleName("---\nname:   \n---\nbody\n"), null);
    assert.equal(parseStyleName("---\nname: Unterminated\nbody\n"), null);
    assert.equal(parseStyleName(""), null);
});

test("parseStyleName strips surrounding quotes", () => {
    assert.equal(parseStyleName('---\nname: "Quoted Name"\n---\n'), "Quoted Name");
});


// --- checkOutputStyle: the three outcomes ----------------------------------

test("a dangling unprefixed name is unresolved and suggests the prefixed one", () => {
    const v = verdict("Terse");
    assert.equal(v.kind, "unresolved");
    assert.equal(v.suggestion, "output-styles:Terse");
});

test("the correct prefixed name resolves and emits nothing", () => {
    const v = verdict("output-styles:Terse");
    assert.equal(v.kind, "resolves");
    assert.deepEqual(formatVerdicts([v], []), []);
});

test("regression: bare Concise resolves to the built-in, so it is ambiguous not broken", () => {
    // Built-in Concise shadows the plugin's Concise. A "missing from the plugin
    // list -> warn" rule would report this working config as broken.
    const v = verdict("Concise");
    assert.equal(v.kind, "ambiguous");
    assert.deepEqual(v.shadowed, ["output-styles:Concise"]);

    const results = formatVerdicts([v], []);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "warning");
    assert.match(results[0].message, /output-styles:Concise/);
    assert.doesNotMatch(results[0].message, /matches no available style/);
});

test("a prefixed name with no unprefixed twin is not reported as ambiguous", () => {
    assert.equal(verdict("output-styles:Concise").kind, "resolves");
});

test("an unprefixed built-in with no plugin twin resolves cleanly", () => {
    assert.equal(verdict("Explanatory").kind, "resolves");
    assert.equal(verdict("default").kind, "resolves");
});

test("a user-level style shadowing a plugin style is ambiguous too", () => {
    const available = { ...AVAILABLE, user: ["Terse"] };
    const v = verdict("Terse", available);
    assert.equal(v.kind, "ambiguous");
    assert.deepEqual(v.shadowed, ["output-styles:Terse"]);
});

test("checkOutputStyle reports one verdict per source, naming the file", () => {
    const verdicts = checkOutputStyle(
        [
            { source: "/a/settings.json", value: "Terse" },
            { source: "/b/settings.local.json", value: "output-styles:Terse" },
        ],
        AVAILABLE,
    );
    assert.deepEqual(verdicts.map((v) => v.kind), ["unresolved", "resolves"]);
    assert.equal(verdicts[0].configured.source, "/a/settings.json");

    const results = formatVerdicts(verdicts, []);
    assert.equal(results.length, 1);
    assert.match(results[0].message, /\/a\/settings\.json/);
});


// --- suggestion order ------------------------------------------------------

test("suggestion rule 1: suffix after the colon, case-insensitively", () => {
    const names = allStyleNames(AVAILABLE);
    assert.equal(suggestStyleName("Terse", names), "output-styles:Terse");
    assert.equal(suggestStyleName("terse", names), "output-styles:Terse");
});

test("suggestion rule 2: case-insensitive exact match fixes the casing", () => {
    const names = allStyleNames(AVAILABLE);
    assert.equal(suggestStyleName("explanatory", names), "Explanatory");
});

test("suggestion rule 3: prefix match", () => {
    const names = allStyleNames(AVAILABLE);
    assert.equal(suggestStyleName("Explan", names), "Explanatory");
    assert.equal(suggestStyleName("Ters", names), "output-styles:Terse");
});

test("suggestion rule 4: nothing close, so the available names are listed", () => {
    const v = verdict("Bogus");
    assert.equal(v.kind, "unresolved");
    assert.equal(v.suggestion, null);

    const [result] = formatVerdicts([v], []);
    assert.equal(result.status, "warning");
    assert.match(result.message, /Available: .*output-styles:Terse/);
});

test("an empty configured value never prefix-matches everything", () => {
    assert.equal(suggestStyleName("", allStyleNames(AVAILABLE)), null);
    assert.equal(suggestStyleName("   ", allStyleNames(AVAILABLE)), null);
});

test("allStyleNames dedupes and orders deterministically", () => {
    const names = allStyleNames({
        plugin: ["output-styles:Terse", "output-styles:Terse"],
        user: ["Concise"],
        builtin: ["Concise", "default"],
    });
    assert.deepEqual(names, ["Concise", "default", "output-styles:Terse"]);
});


// --- enumeration from three sources ----------------------------------------

test("plugin styles are prefixed with the plugin directory name", async () => {
    // plugins/fake-styles/output-styles/not-the-name.md -> fake-styles:FancyStyle.
    // The real tree cannot prove this: there, the plugin dir and the style dir
    // are both named "output-styles".
    const styles = await listPluginStyles(ODD_REPO);
    assert.deepEqual(styles.map((s) => s.qualifiedName), ["fake-styles:FancyStyle"]);
    assert.equal(styles[0].file, "not-the-name.md");
});

test("enumeration unions plugin, user, and built-in names", async () => {
    const available = await enumerateAvailableStyles(REPO, claude("claude-user-style"));
    assert.deepEqual(available.plugin, ["output-styles:Concise", "output-styles:Terse"]);
    assert.deepEqual(available.user, ["HouseStyle"]);
    assert.deepEqual(available.builtin, [...BUILTIN_STYLE_NAMES]);
    assert.ok(allStyleNames(available).includes("HouseStyle"));
});

test("the real repo publishes output-styles:Terse and output-styles:Concise", async () => {
    const styles = await listPluginStyles(ROOT);
    const names = styles.map((s) => s.qualifiedName);
    assert.ok(names.includes("output-styles:Terse"), names.join(", "));
    assert.ok(names.includes("output-styles:Concise"), names.join(", "));
    assert.ok(!names.includes("Terse"), "unprefixed names must not be published");
});

test("a missing user output-styles directory yields no user styles", async () => {
    assert.deepEqual(await listUserStyles(claude("claude-missing")), []);
    assert.deepEqual(await listUserStyles(join(FIXTURES, "does-not-exist")), []);
});


// --- reading configured values ---------------------------------------------

test("only the three permitted settings files are read", () => {
    assert.deepEqual(configuredStyleSources("/repo", "/home/.claude"), [
        "/home/.claude/settings.json",
        "/repo/.claude/settings.json",
        "/repo/.claude/settings.local.json",
    ]);
});

test("defaultClaudeDir points at the user-level directory", () => {
    assert.ok(defaultClaudeDir().endsWith("/.claude"));
});

test("configured values are reported per source with the file path", async () => {
    // The repo-side settings live in a temp dir: a committed fixture named
    // `.claude/settings.local.json` is excluded by the user-level gitignore.
    const repo = await mkdtemp(join(tmpdir(), "style-check-repo-"));
    await mkdir(join(repo, ".claude"));
    await writeFile(join(repo, ".claude/settings.json"), '{"outputStyle":"project-shared"}');
    await writeFile(
        join(repo, ".claude/settings.local.json"),
        '{"outputStyle":"project-local"}',
    );

    const found = await readConfiguredStyles(repo, claude("claude-dangling"));
    assert.deepEqual(found, [
        { source: join(claude("claude-dangling"), "settings.json"), value: "Terse" },
        { source: join(repo, ".claude/settings.json"), value: "project-shared" },
        { source: join(repo, ".claude/settings.local.json"), value: "project-local" },
    ]);

    // One unreadable source must not discard the ones that parsed.
    await writeFile(join(repo, ".claude/settings.local.json"), "{ broken");
    assert.deepEqual(await readConfiguredStyles(repo, claude("claude-dangling")), [
        { source: join(claude("claude-dangling"), "settings.json"), value: "Terse" },
        { source: join(repo, ".claude/settings.json"), value: "project-shared" },
    ]);
});

test("a non-string or blank outputStyle is ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "style-check-claude-"));
    await writeFile(join(dir, "settings.json"), '{"outputStyle": 42, "other": "x"}');
    assert.deepEqual(await readConfiguredStyles(REPO, dir), []);

    await writeFile(join(dir, "settings.json"), '{"outputStyle": "   "}');
    assert.deepEqual(await readConfiguredStyles(REPO, dir), []);
});

test("a missing, empty, or malformed settings file is tolerated", async () => {
    for (const fixture of ["claude-missing", "claude-empty", "claude-malformed"]) {
        assert.deepEqual(await readConfiguredStyles(REPO, claude(fixture)), [], fixture);
    }
});


// --- stale copies left by the retired file-copy route ----------------------

test("a stale style copy is reported and left on disk", async () => {
    const stalePath = join(claude("claude-stale"), "output-styles/terse.md");
    const before = await readFile(stalePath, "utf8");

    const stale = await findStaleStyleCopies(REPO, claude("claude-stale"));
    assert.equal(stale.length, 1);
    assert.equal(stale[0].path, stalePath);
    assert.equal(stale[0].bareName, "Terse");
    assert.equal(stale[0].canonicalName, "output-styles:Terse");
    assert.equal(stale[0].linkTarget, null);
    assert.equal(stale[0].linksIntoRepo, false);

    // The detector must never remove what it finds.
    assert.ok((await stat(stalePath)).isFile());
    assert.equal(await readFile(stalePath, "utf8"), before);

    const [result] = formatVerdicts([], stale);
    assert.equal(result.status, "warning");
    assert.match(result.message, /terse\.md/);
    assert.match(result.message, /"Terse"/);
    assert.match(result.message, /"output-styles:Terse"/);
    assert.match(result.message, new RegExp(`rm ${stalePath.replaceAll(".", "\\.")}`));
});

test("a stale copy that links back into the checkout is labelled as such", async () => {
    const dir = await mkdtemp(join(tmpdir(), "style-check-"));
    const styleDir = join(dir, "output-styles");
    await mkdir(styleDir);
    const source = join(REPO, "plugins/output-styles/output-styles/terse.md");
    await symlink(source, join(styleDir, "terse.md"));

    const stale = await findStaleStyleCopies(REPO, dir);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].linkTarget, source);
    assert.equal(stale[0].linksIntoRepo, true);
    assert.equal(stale[0].bareName, "Terse");

    const [result] = formatVerdicts([], stale);
    assert.match(result.message, /Stale symbolic link into this checkout/);
    assert.match(result.message, /rm /);
});

test("no stale copies when the user style directory is absent", async () => {
    assert.deepEqual(await findStaleStyleCopies(REPO, claude("claude-missing")), []);
});


// --- the module cannot write ----------------------------------------------

test("the module's source contains no mutating filesystem call", async () => {
    const source = await readFile(MODULE_PATH, "utf8");
    for (const forbidden of ["writeFile", "mkdir", "unlink", "copyFile", "symlink"]) {
        assert.ok(!source.includes(forbidden), `source must not mention ${forbidden}`);
    }
});

test("the module imports only read-only node:fs/promises functions", async () => {
    const source = await readFile(MODULE_PATH, "utf8");
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs\/promises"/g)];
    assert.equal(imports.length, 1);
    const named = imports[0][1].split(",").map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(named, ["readFile", "readdir", "readlink"]);
});


// --- end to end -----------------------------------------------------------

test("runOutputStyleCheck warns once about a dangling Terse", async () => {
    const results = await runOutputStyleCheck(REPO, claude("claude-dangling"));
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "warning");
    assert.match(results[0].message, /output-styles:Terse/);
    assert.match(results[0].message, /settings\.json/);
});

test("runOutputStyleCheck stays silent on correct config", async () => {
    assert.deepEqual(await runOutputStyleCheck(REPO, claude("claude-correct")), []);
});

test("runOutputStyleCheck treats a shadowed Concise as ambiguous, not broken", async () => {
    const results = await runOutputStyleCheck(REPO, claude("claude-shadowed"));
    assert.equal(results.length, 1);
    assert.match(results[0].message, /resolves to the unprefixed style/);
});

test("runOutputStyleCheck reports both the shadowing and the stale copy", async () => {
    const results = await runOutputStyleCheck(REPO, claude("claude-stale"));
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === "warning"));
    assert.match(results[0].message, /resolves to the unprefixed style/);
    assert.match(results[1].message, /Stale file copy/);
});

test("runOutputStyleCheck never reports an error status and never throws", async () => {
    for (const fixture of [
        "claude-missing",
        "claude-empty",
        "claude-malformed",
        "claude-stale",
        "claude-dangling",
    ]) {
        const results = await runOutputStyleCheck(REPO, claude(fixture));
        assert.ok(
            results.every((r) => r.status === "warning"),
            `${fixture} produced a non-warning status`,
        );
    }
    assert.deepEqual(await runOutputStyleCheck(join(FIXTURES, "nope"), join(FIXTURES, "nope")), []);
});


// --- wiring ---------------------------------------------------------------

test("ResultsView renders a warning with its own icon and colour", async () => {
    const { ResultsView } = await import(
        join(ROOT, "packages/installer/src/components/ResultsView.ts")
    );
    const styled = (status) => {
        const element = ResultsView({
            results: [{ packageId: "p", itemName: "i", status, message: "m" }],
        });
        const found = [];
        const walk = (node) => {
            if (Array.isArray(node)) return node.forEach(walk);
            if (!node || typeof node !== "object" || !node.props) return;
            if (node.props.color) found.push({ color: node.props.color, text: node.props.children });
            walk(node.props.children);
        };
        walk(element);
        return found[0];
    };

    const warning = styled("warning");
    const error = styled("error");
    assert.equal(warning.color, "yellow");
    assert.notEqual(warning.text, error.text, "a warning must not render the error icon");
});

test("the CLI entrypoints gate the exit code on error only, and run the check", async () => {
    for (const file of ["reinstall.ts", "install-package.ts"]) {
        const source = await readFile(join(ROOT, "packages/installer/src", file), "utf8");
        assert.match(source, /if \(result\.status === "error"\) hasError = true;/, file);
        assert.ok(!/status === "warning"[^\n]*hasError/.test(source), file);
        assert.match(source, /runOutputStyleCheck\(repoRoot\)/, file);
    }
    const hook = await readFile(join(ROOT, "packages/installer/src/hooks/useInstaller.ts"), "utf8");
    assert.match(hook, /runOutputStyleCheck\(repoRoot\)/);
});
