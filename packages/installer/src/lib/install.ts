import { mkdir, symlink, readlink, readFile, writeFile, copyFile, unlink, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileHash } from "./hash.ts";
import { agentsInstallDir, claudeDir, skillsInstallDir } from "./paths.ts";
import {
    claudeBin,
    compareVersions,
    describeFailure,
    isMissingBinary,
    marketplaceListArgv,
    missingBinaryMessage,
    parseMarketplaceList,
    parsePluginList,
    pluginInstallArgv,
    pluginListArgv,
    pluginUninstallArgv,
    pluginUpdateArgv,
    realSpawn,
    versionArgv,
    type Spawn,
} from "./plugin-cli.ts";
import type { InstallResult, PackageDescriptor, PackageManifest } from "./types.ts";

/** Resolve a files-package destination dir, expanding a leading ~. Defaults to ~/.claude/. */
function resolveDestDir(manifest: PackageManifest): string {
    if (!manifest.destDir) return claudeDir();
    return manifest.destDir.replace(/^~/, process.env.HOME!);
}

export async function installPackage(
    pkg: PackageDescriptor,
    spawn: Spawn = realSpawn,
): Promise<InstallResult[]> {
    if (pkg.type === "plugin") {
        return installPlugin(pkg, spawn);
    }
    if (pkg.type === "skills") {
        return installSkills(pkg);
    }
    return installFiles(pkg);
}

export async function removePackage(
    pkg: PackageDescriptor,
    spawn: Spawn = realSpawn,
): Promise<InstallResult[]> {
    if (pkg.type === "plugin") {
        return removePlugin(pkg, spawn);
    }
    if (pkg.type === "skills") {
        return removeSkills(pkg);
    }
    return removeFiles(pkg);
}

/**
 * Install a plugin by invoking the Claude Code CLI.
 *
 * Never copies the plugin's files. Copying a plugin's output-styles/, skills/ or
 * agents/ into ~/.claude/ makes the same asset discoverable under a second,
 * unprefixed name, so `output-styles:Terse` also appears as a bare `Terse` that
 * no plugin owns. That duplicate identity is the bug this function replaced.
 *
 * Note for callers surfacing these results: a plugin change needs a Claude Code
 * restart (or /reload-plugins) before it takes effect, and the install resolves
 * against the marketplace's published source rather than this working tree.
 */
async function installPlugin(
    pkg: PackageDescriptor,
    spawn: Spawn = realSpawn,
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    const targets = pkg.items.filter(
        (item) => item.enabled && item.itemType === "plugin" && item.pluginId,
    );
    if (targets.length === 0) return results;

    const marketplaceSource = pkg.marketplaceSource ?? "";

    // 1. Binary present? A missing CLI is reported, never worked around.
    try {
        await spawn(claudeBin(), versionArgv());
    } catch (err) {
        if (isMissingBinary(err)) {
            for (const item of targets) {
                results.push({
                    packageId: pkg.id,
                    itemName: item.name,
                    status: "error",
                    message: missingBinaryMessage(item.pluginId!, marketplaceSource),
                });
            }
            return results;
        }
    }

    // 2. Marketplace registered? Never auto-add it: the name is already bound to
    //    a published source, and rebinding it to a local path would clobber a
    //    working registry entry.
    const marketplaceName = pkg.marketplaceName;
    if (marketplaceName) {
        try {
            const listed = await spawn(claudeBin(), marketplaceListArgv());
            const known = parseMarketplaceList(listed.stdout);
            if (known.size > 0 && !known.has(marketplaceName)) {
                for (const item of targets) {
                    results.push({
                        packageId: pkg.id,
                        itemName: item.name,
                        status: "error",
                        message:
                            `Marketplace "${marketplaceName}" is not registered — ` +
                            `run \`claude plugin marketplace add ${marketplaceSource}\` first.`,
                    });
                }
                return results;
            }
        } catch {
            // Probe failed for a non-ENOENT reason; fall through and let the
            // install itself report the real error.
        }
    }

    // 3. What's installed already?
    let installed = new Map<string, { version: string; enabled: boolean }>();
    try {
        const listed = await spawn(claudeBin(), pluginListArgv());
        installed = parsePluginList(listed.stdout);
    } catch {
        // Treat an unreadable list as "nothing installed" and let install decide.
    }

    for (const item of targets) {
        const id = item.pluginId!;
        const current = installed.get(id);
        const expected = item.pluginVersion ?? "";

        try {
            // Up to date: run nothing at all.
            if (current && expected && compareVersions(expected, current.version) <= 0) {
                results.push({
                    packageId: pkg.id,
                    itemName: item.name,
                    status: "already-exists",
                    message: current.enabled
                        ? `Already installed: ${id} v${current.version}`
                        : `Already installed: ${id} v${current.version} — disabled; ` +
                          `run \`claude plugin enable ${id}\` to turn it on`,
                });
                continue;
            }

            const upgrading = Boolean(current);
            const argv = upgrading ? pluginUpdateArgv(id) : pluginInstallArgv(id);
            const run = await spawn(claudeBin(), argv);

            if (run.code !== 0) {
                results.push({
                    packageId: pkg.id,
                    itemName: item.name,
                    status: "error",
                    message: `${id}: ${describeFailure(run)}`,
                });
                continue;
            }

            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: upgrading ? "updated" : "created",
                message: upgrading
                    ? `Updated: ${id}${expected ? ` → v${expected}` : ""} (restart Claude Code to apply)`
                    : `Installed: ${id}${expected ? ` v${expected}` : ""} (restart Claude Code to apply)`,
            });
        } catch (err) {
            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: "error",
                message: isMissingBinary(err)
                    ? missingBinaryMessage(id, marketplaceSource)
                    : `${id}: ${(err as Error).message}`,
            });
        }
    }

    return results;
}

/** Uninstall a plugin through the CLI, mirroring installPlugin. */
async function removePlugin(
    pkg: PackageDescriptor,
    spawn: Spawn = realSpawn,
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];

    for (const item of pkg.items) {
        if (!item.markedForRemoval) continue;
        if (item.itemType !== "plugin" || !item.pluginId) continue;

        const id = item.pluginId;
        try {
            const run = await spawn(claudeBin(), pluginUninstallArgv(id));
            if (run.code !== 0) {
                results.push({
                    packageId: pkg.id,
                    itemName: item.name,
                    status: "error",
                    message: `${id}: ${describeFailure(run)}`,
                });
                continue;
            }
            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: "removed",
                message: `Uninstalled: ${id} (restart Claude Code to apply)`,
            });
        } catch (err) {
            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: "error",
                message: isMissingBinary(err)
                    ? missingBinaryMessage(id, pkg.marketplaceSource ?? "")
                    : `${id}: ${(err as Error).message}`,
            });
        }
    }

    return results;
}

/** Create a symlink at `target` pointing to `sourcePath`, replacing any existing entry. */
async function symlinkItem(sourcePath: string, target: string): Promise<void> {
    try {
        const linkTarget = await readlink(target);
        if (resolve(dirname(target), linkTarget) === resolve(sourcePath)) return;
    } catch {
        // Not a symlink or doesn't exist
    }
    await unlink(target).catch(() => {});
    await symlink(sourcePath, target);
}

async function removeSkills(
    pkg: PackageDescriptor,
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];

    for (const item of pkg.items) {
        if (!item.markedForRemoval) continue;

        const target = join(skillsInstallDir(), item.name);
        try {
            await unlink(target);
            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: "removed",
                message: `Removed: ${item.name}`,
            });
        } catch (err) {
            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: "error",
                message: `${item.name}: ${(err as Error).message}`,
            });
        }
    }

    return results;
}

async function removeFiles(
    pkg: PackageDescriptor,
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    const manifest = pkg.manifest;
    const files = manifest.files ?? [];
    const destDir = resolveDestDir(manifest);

    for (const item of pkg.items) {
        if (!item.markedForRemoval) continue;

        if (item.name === "settings.json config" && manifest.settings) {
            const settingsPath = join(claudeDir(), "settings.json");
            try {
                const raw = await readFile(settingsPath, "utf-8");
                const settings = JSON.parse(raw) as Record<string, unknown>;
                for (const key of Object.keys(manifest.settings)) {
                    delete settings[key];
                }
                await writeFile(settingsPath, JSON.stringify(settings, null, 4) + "\n");
                results.push({
                    packageId: pkg.id,
                    itemName: item.name,
                    status: "removed",
                    message: "Removed keys from settings.json",
                });
            } catch (err) {
                results.push({
                    packageId: pkg.id,
                    itemName: item.name,
                    status: "error",
                    message: `settings.json: ${(err as Error).message}`,
                });
            }
        } else {
            for (const file of files) {
                try {
                    await unlink(join(destDir, file));
                    results.push({
                        packageId: pkg.id,
                        itemName: file,
                        status: "removed",
                        message: `Removed: ${file}`,
                    });
                } catch (err) {
                    results.push({
                        packageId: pkg.id,
                        itemName: file,
                        status: "error",
                        message: `${file}: ${(err as Error).message}`,
                    });
                }
            }
        }
    }

    return results;
}

async function installSkills(
    pkg: PackageDescriptor,
): Promise<InstallResult[]> {
    await mkdir(skillsInstallDir(), { recursive: true });
    const results: InstallResult[] = [];

    for (const item of pkg.items) {
        if (!item.enabled || !item.sourcePath) continue;

        const target = join(skillsInstallDir(), item.name);
        try {
            try {
                const linkTarget = await readlink(target);
                const resolvedLink = resolve(skillsInstallDir(), linkTarget);
                if (resolvedLink === resolve(item.sourcePath)) {
                    results.push({
                        packageId: pkg.id,
                        itemName: item.name,
                        status: "already-exists",
                        message: `Already linked: ${item.name}`,
                    });
                    continue;
                }
            } catch {
                // Not a symlink or doesn't exist
            }

            await unlink(target).catch(() => {});
            await symlink(item.sourcePath, target);
            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: "created",
                message: `Linked: ${item.name}`,
            });
        } catch (err) {
            results.push({
                packageId: pkg.id,
                itemName: item.name,
                status: "error",
                message: `${item.name}: ${(err as Error).message}`,
            });
        }
    }

    return results;
}

async function installFiles(
    pkg: PackageDescriptor,
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    const manifest = pkg.manifest;
    const files = manifest.files ?? [];
    const destDir = resolveDestDir(manifest);

    await mkdir(destDir, { recursive: true });

    // Copy files
    for (const file of files) {
        const src = join(pkg.packageDir, file);
        const dest = join(destDir, file);
        try {
            const existed = await stat(dest).then(() => true, () => false);
            // Re-apply/confirm runs this loop on every pass, so hash-compare to
            // report already-exists instead of a misleading "updated". Skipping
            // the copy also stops a symlink-into-repo dest being clobbered with a
            // real file (fileHash follows the link, so it matches).
            if (existed && (await fileHash(src)) === (await fileHash(dest))) {
                results.push({
                    packageId: pkg.id,
                    itemName: file,
                    status: "already-exists",
                    message: `Already up to date: ${file}`,
                });
                continue;
            }
            await mkdir(dirname(dest), { recursive: true });
            await copyFile(src, dest);
            results.push({
                packageId: pkg.id,
                itemName: file,
                status: existed ? "updated" : "created",
                message: existed ? `Updated: ${file}` : `Copied: ${file}`,
            });
        } catch (err) {
            results.push({
                packageId: pkg.id,
                itemName: file,
                status: "error",
                message: `${file}: ${(err as Error).message}`,
            });
        }
    }

    // Merge settings.json if manifest specifies settings
    if (manifest.settings) {
        const settingsPath = join(claudeDir(), "settings.json");
        try {
            let settings: Record<string, unknown> = {};
            try {
                const raw = await readFile(settingsPath, "utf-8");
                settings = JSON.parse(raw);
            } catch {
                // File doesn't exist or invalid — start fresh
            }

            let anyChanged = false;
            for (const [key, value] of Object.entries(manifest.settings)) {
                const existing = JSON.stringify(settings[key]);
                const desired = JSON.stringify(value);
                if (existing !== desired) {
                    settings[key] = value;
                    anyChanged = true;
                }
            }

            if (anyChanged) {
                await writeFile(settingsPath, JSON.stringify(settings, null, 4) + "\n");
                results.push({
                    packageId: pkg.id,
                    itemName: "settings.json",
                    status: "created",
                    message: "Updated settings.json",
                });
            } else {
                results.push({
                    packageId: pkg.id,
                    itemName: "settings.json",
                    status: "already-exists",
                    message: "settings.json already configured",
                });
            }
        } catch (err) {
            results.push({
                packageId: pkg.id,
                itemName: "settings.json",
                status: "error",
                message: `settings.json: ${(err as Error).message}`,
            });
        }
    }

    return results;
}
