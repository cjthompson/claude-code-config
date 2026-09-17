import { readdir, stat, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileHash } from "./hash.ts";
import { claudeDir, skillsInstallDir } from "./paths.ts";
import {
    claudeBin,
    compareVersions,
    parsePluginList,
    pluginListArgv,
    realSpawn,
    type Spawn,
} from "./plugin-cli.ts";
import type { DetectSpec, PackageDescriptor, PackageItem, PackageManifest } from "./types.ts";

export async function discoverPackages(
    repoRoot: string,
    spawn: Spawn = realSpawn,
): Promise<PackageDescriptor[]> {
    const packages: PackageDescriptor[] = [];

    // Discover traditional packages from packages/
    const packagesDir = join(repoRoot, "packages");
    const entries = await readdir(packagesDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "installer") continue;

        const pkgPath = join(packagesDir, entry.name);
        const manifestPath = join(pkgPath, "manifest.json");

        if (!(await exists(manifestPath))) continue;

        const manifest: PackageManifest = JSON.parse(
            await readFile(manifestPath, "utf-8"),
        );

        const pkg = manifest.type === "skills"
            ? await discoverSkillsPackage(entry.name, pkgPath, manifest)
            : await discoverFilesPackage(entry.name, pkgPath, manifest, repoRoot);

        if (pkg) packages.push(pkg);
    }

    // Discover skills, files, and agents from plugins/ (Claude Code plugin format)
    const pluginPkgs = await discoverPlugins(repoRoot, spawn);
    packages.push(...pluginPkgs);

    packages.sort((a, b) => a.label.localeCompare(b.label));
    return packages;
}

async function discoverSkillsPackage(
    id: string,
    pkgDir: string,
    manifest: PackageManifest,
): Promise<PackageDescriptor | null> {
    const entries = await readdir(pkgDir, { withFileTypes: true });
    const items: PackageItem[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = join(pkgDir, entry.name);
        const skillMd = join(skillPath, "SKILL.md");

        if (!(await exists(skillMd))) continue;

        const detectOverride = manifest.detect?.[entry.name];
        const installed = detectOverride
            ? await checkDetect(detectOverride)
            : await isSkillInstalled(entry.name);
        const description = await extractSkillDescription(skillMd);
        items.push({
            name: entry.name,
            sourcePath: skillPath,
            enabled: !installed,
            alreadyInstalled: installed,
            description,
            typeLabel: "Skill",
        });
    }

    if (items.length === 0) return null;
    items.sort((a, b) => a.name.localeCompare(b.name));

    return {
        id,
        label: manifest.label,
        description: manifest.description,
        type: "skills",
        enabled: items.some((i) => i.enabled),
        items,
        packageDir: pkgDir,
        manifest,
    };
}

async function discoverFilesPackage(
    id: string,
    pkgDir: string,
    manifest: PackageManifest,
    repoRoot: string,
): Promise<PackageDescriptor | null> {
    const files = manifest.files ?? [];
    if (files.length === 0) return null;

    const destDir = resolveDestDir(manifest);

    // Check if all files are already installed (or use detect override for the files item)
    const filesItemName = files.join(", ");
    const filesDetect = manifest.detect?.[filesItemName];
    const allExist = filesDetect
        ? await checkDetect(filesDetect)
        : (await Promise.all(files.map((f) => exists(join(destDir, f))))).every(Boolean);

    // If files exist, check if any are outdated (hash mismatch).
    // Symlinks pointing into the repo are excluded — they auto-update.
    let needsUpgrade = false;
    if (allExist) {
        for (const file of files) {
            const dest = join(destDir, file);
            if (await isSymlinkIntoRepo(dest, repoRoot)) continue;
            const src = join(pkgDir, file);
            if (await fileHash(src) !== await fileHash(dest)) {
                needsUpgrade = true;
                break;
            }
        }
    }

    const allInstalled = allExist && !needsUpgrade;
    const isCurrent = allExist && !needsUpgrade;

    const filesDesc = `Files: ${files.join(", ")}\nInstall destination: ${manifest.destDir ?? "~/.claude/"}`;
    const exampleDesc = manifest.example ? `\nExample:\n  ${manifest.example}` : "";
    const items: PackageItem[] = [
        {
            name: files.join(", "),
            enabled: !allInstalled,
            alreadyInstalled: allInstalled,
            needsUpgrade,
            isCurrent,
            sourcePath: pkgDir,
            description: manifest.description + "\n\n" + filesDesc + exampleDesc,
            typeLabel: "Package",
        },
    ];

    if (manifest.settings) {
        const settingsDetect = manifest.detect?.["settings.json config"];
        const settingsInstalled = settingsDetect
            ? await checkDetect(settingsDetect)
            : await checkDetect({ settings: Object.keys(manifest.settings) });
        items.push({
            name: "settings.json config",
            enabled: !settingsInstalled,
            alreadyInstalled: settingsInstalled,
            description: "Merges configuration into ~/.claude/settings.json.",
            typeLabel: "Package",
        });
    }

    return {
        id,
        label: manifest.label,
        description: manifest.description,
        type: "files",
        enabled: items.some((i) => i.enabled),
        items,
        packageDir: pkgDir,
        manifest,
    };
}

/**
 * Discover plugins/ directory (Claude Code plugin format).
 *
 * A plugin is one atomic unit — that is what `claude plugin install` operates
 * on — so each plugins/<name>/ with a .claude-plugin/plugin.json yields exactly
 * one PackageDescriptor holding one itemType "plugin" item.
 *
 * Its skills/ and agents/ are scanned only to build a human-readable
 * description. They are deliberately NOT emitted as installable items: copying
 * or symlinking them into ~/.claude/ would publish the same asset under a
 * second, unprefixed name alongside the plugin's own `<plugin>:<name>`.
 * `manifest.json` files[] is no longer read at all, for the same reason.
 */
async function discoverPlugins(
    repoRoot: string,
    spawn: Spawn = realSpawn,
): Promise<PackageDescriptor[]> {
    const pluginsDir = join(repoRoot, "plugins");
    if (!(await exists(pluginsDir))) return [];

    const { name: marketplaceName, source: marketplaceSource, versions } =
        await readMarketplace(repoRoot);

    // One CLI probe for every plugin. Discovery must stay usable when the binary
    // is absent, so a failure degrades to "nothing installed".
    let installed = new Map<string, { version: string; enabled: boolean }>();
    try {
        const listed = await spawn(claudeBin(), pluginListArgv());
        installed = parsePluginList(listed.stdout);
    } catch {
        // claude not on PATH, or unparseable output.
    }

    const pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
    const descriptors: PackageDescriptor[] = [];

    for (const pluginEntry of pluginEntries) {
        if (!pluginEntry.isDirectory()) continue;
        const pluginDir = join(pluginsDir, pluginEntry.name);

        // Gate on plugin.json, not on item count: a plugin with no skills and no
        // agents is still installable, and gating on items would silently drop it.
        const pluginJsonPath = join(pluginDir, ".claude-plugin", "plugin.json");
        if (!(await exists(pluginJsonPath))) continue;

        const pluginJson = JSON.parse(await readFile(pluginJsonPath, "utf-8")) as {
            name?: string;
            description?: string;
            version?: string;
        };
        const name = pluginJson.name ?? pluginEntry.name;
        const description = pluginJson.description ?? "";

        // marketplace.json is the authoritative version: plugin.json omits the
        // field for most plugins (stripped in ce06e08).
        const version = versions.get(pluginEntry.name) ?? pluginJson.version ?? "";

        const id = marketplaceName ? `${name}@${marketplaceName}` : name;
        const current = installed.get(id);
        const upToDate = Boolean(
            current && version && compareVersions(version, current.version) <= 0,
        );
        const needsUpgrade = Boolean(current) && !upToDate;

        const inventory = await describePluginContents(pluginDir);
        const detail = [
            description,
            inventory,
            `Installs via: claude plugin install ${id}`,
            "Source: the marketplace's published catalog, not this working tree.",
            "A restart (or /reload-plugins) is needed for changes to take effect.",
        ]
            .filter(Boolean)
            .join("\n\n");

        descriptors.push({
            id: `plugin:${pluginEntry.name}`,
            label: name,
            description,
            type: "plugin",
            enabled: !current || needsUpgrade,
            items: [
                {
                    name,
                    sourcePath: pluginDir,
                    enabled: !current || needsUpgrade,
                    alreadyInstalled: upToDate,
                    needsUpgrade,
                    isCurrent: upToDate,
                    description: detail,
                    typeLabel: "Plugin",
                    itemType: "plugin",
                    pluginId: id,
                    pluginVersion: version,
                },
            ],
            packageDir: pluginDir,
            manifest: { label: name, description, type: "skills" },
            marketplaceName,
            marketplaceSource,
        });
    }

    return descriptors;
}

/** Read the repo's marketplace name, source hint, and per-plugin versions. */
async function readMarketplace(repoRoot: string): Promise<{
    name: string;
    source: string;
    versions: Map<string, string>;
}> {
    const versions = new Map<string, string>();
    const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
    try {
        const parsed = JSON.parse(await readFile(marketplacePath, "utf-8")) as {
            name?: string;
            owner?: { name?: string };
            plugins?: { name?: string; source?: string; version?: string }[];
        };
        for (const entry of parsed.plugins ?? []) {
            // source is "./plugins/<dir>"; key by directory so it matches the scan.
            const dir = entry.source?.replace(/^\.\/plugins\//, "") ?? entry.name;
            if (dir && entry.version) versions.set(dir, entry.version);
        }
        const name = parsed.name ?? "";
        const owner = parsed.owner?.name ?? "";
        // What a user would pass to `marketplace add`. Derived from the manifest,
        // never from repoRoot's basename — in a git worktree that directory is
        // named after the branch, which would print a nonexistent repo.
        // Marketplace names follow "<owner>-<repo>", so strip the owner prefix.
        const repo = owner && name.startsWith(`${owner}-`)
            ? name.slice(owner.length + 1)
            : name;
        const source = owner && repo ? `${owner}/${repo}` : name;
        return { name, source, versions };
    } catch {
        return { name: "", source: "", versions };
    }
}

/** Summarize a plugin's components for the info overlay. Not installable items. */
async function describePluginContents(pluginDir: string): Promise<string> {
    const parts: string[] = [];

    const skillsDir = join(pluginDir, "skills");
    if (await exists(skillsDir)) {
        const entries = await readdir(skillsDir, { withFileTypes: true });
        const names: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (!(await exists(join(skillsDir, entry.name, "SKILL.md")))) continue;
            names.push(entry.name);
        }
        if (names.length > 0) parts.push(`Skills: ${names.sort().join(", ")}`);
    }

    const agentsDir = join(pluginDir, "agents");
    if (await exists(agentsDir)) {
        const entries = await readdir(agentsDir, { withFileTypes: true });
        const names = entries
            .filter((e) => e.isFile() && e.name.endsWith(".md"))
            .map((e) => e.name.replace(/\.md$/, ""))
            .sort();
        if (names.length > 0) parts.push(`Agents: ${names.join(", ")}`);
    }

    const stylesDir = join(pluginDir, "output-styles");
    if (await exists(stylesDir)) {
        const entries = await readdir(stylesDir, { withFileTypes: true });
        const names = entries
            .filter((e) => e.isFile() && e.name.endsWith(".md"))
            .map((e) => e.name.replace(/\.md$/, ""))
            .sort();
        if (names.length > 0) parts.push(`Output styles: ${names.join(", ")}`);
    }

    return parts.join(" · ");
}

/** Resolve a files-package destination dir, expanding a leading ~. Defaults to ~/.claude/. */
function resolveDestDir(manifest: PackageManifest): string {
    if (!manifest.destDir) return claudeDir();
    return manifest.destDir.replace(/^~/, process.env.HOME!);
}

/** Check if a skill is installed: exists in ~/.claude/skills/ (any symlink or directory). */
async function isSkillInstalled(name: string): Promise<boolean> {
    return exists(join(skillsInstallDir(), name));
}

/** Run a DetectSpec: all checks must pass. */
async function checkDetect(spec: DetectSpec): Promise<boolean> {
    if (spec.files) {
        for (const f of spec.files) {
            const expanded = f.replace(/^~/, process.env.HOME!);
            if (!(await exists(expanded))) return false;
        }
    }
    if (spec.settings) {
        const settingsPath = join(claudeDir(), "settings.json");
        try {
            const raw = await readFile(settingsPath, "utf-8");
            const json = JSON.parse(raw) as Record<string, unknown>;
            for (const key of spec.settings) {
                if (!(key in json)) return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

async function extractSkillDescription(skillMdPath: string): Promise<string> {
    try {
        const content = await readFile(skillMdPath, "utf-8");

        // Try frontmatter description first
        if (content.startsWith("---")) {
            const end = content.indexOf("\n---", 3);
            if (end !== -1) {
                const frontmatter = content.slice(3, end);
                const match = frontmatter.match(/^description:\s*(.+)$/m);
                if (match) {
                    // Also grab the first ## section body for extra detail
                    const rest = content.slice(end + 4);
                    const sectionMatch = rest.match(/^##[^#][^\n]*\n+([\s\S]*?)(?=\n##|\n---|$)/m);
                    const sectionBody = sectionMatch ? sectionMatch[1]!.trim() : "";
                    const combined = match[1]!.trim() +
                        (sectionBody ? "\n\n" + sectionBody : "");
                    return combined.length > 500 ? combined.slice(0, 497) + "..." : combined;
                }
            }
        }

        // Fallback: text between # title and first ##
        const lines = content.split("\n");
        const bodyLines: string[] = [];
        let inBody = false;
        for (const line of lines) {
            if (line.startsWith("# ")) { inBody = true; continue; }
            if (inBody && line.startsWith("## ")) break;
            if (inBody) bodyLines.push(line);
        }
        const body = bodyLines.join("\n").trim();
        return body.length > 500 ? body.slice(0, 497) + "..." : body;
    } catch {
        return "";
    }
}

/** Check if `destPath` is a symlink whose target lives inside `repoRoot`. */
async function isSymlinkIntoRepo(destPath: string, repoRoot: string): Promise<boolean> {
    try {
        const target = await readlink(destPath);
        const resolved = resolve(destPath, "..", target);
        return resolved.startsWith(repoRoot + "/");
    } catch {
        return false;
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
