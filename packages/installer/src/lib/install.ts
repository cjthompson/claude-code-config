import { mkdir, symlink, readlink, readFile, writeFile, copyFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { InstallResult, PackageDescriptor, PackageItem } from "./types.ts";

const CLAUDE_DIR = join(process.env.HOME!, ".claude");
const SKILLS_INSTALL_DIR = join(CLAUDE_DIR, "skills");

export async function installPackage(
    pkg: PackageDescriptor,
): Promise<InstallResult[]> {
    if (pkg.type === "skills") {
        return installSkills(pkg);
    }
    return installFiles(pkg);
}

export async function removePackage(
    pkg: PackageDescriptor,
): Promise<InstallResult[]> {
    if (pkg.type === "skills") {
        return removeSkills(pkg);
    }
    return removeFiles(pkg);
}

async function removeSkills(
    pkg: PackageDescriptor,
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];

    for (const item of pkg.items) {
        if (!item.markedForRemoval) continue;

        const target = join(SKILLS_INSTALL_DIR, item.name);
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

    for (const item of pkg.items) {
        if (!item.markedForRemoval) continue;

        if (item.name === "settings.json config" && manifest.settings) {
            const settingsPath = join(CLAUDE_DIR, "settings.json");
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
                    await unlink(join(CLAUDE_DIR, file));
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
    await mkdir(SKILLS_INSTALL_DIR, { recursive: true });
    const results: InstallResult[] = [];

    for (const item of pkg.items) {
        if (!item.enabled || !item.sourcePath) continue;

        const target = join(SKILLS_INSTALL_DIR, item.name);
        try {
            try {
                const linkTarget = await readlink(target);
                const resolvedLink = resolve(SKILLS_INSTALL_DIR, linkTarget);
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

    await mkdir(CLAUDE_DIR, { recursive: true });

    // Copy files
    for (const file of files) {
        const src = join(pkg.packageDir, file);
        const dest = join(CLAUDE_DIR, file);
        try {
            await copyFile(src, dest);
            results.push({
                packageId: pkg.id,
                itemName: file,
                status: "created",
                message: `Copied: ${file}`,
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
        const settingsPath = join(CLAUDE_DIR, "settings.json");
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
