import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DetectSpec, PackageDescriptor, PackageItem, PackageManifest } from "./types.ts";

const CLAUDE_DIR = join(process.env.HOME!, ".claude");
const SKILLS_INSTALL_DIR = join(CLAUDE_DIR, "skills");

export async function discoverPackages(
    repoRoot: string,
): Promise<PackageDescriptor[]> {
    const packagesDir = join(repoRoot, "packages");
    const entries = await readdir(packagesDir, { withFileTypes: true });
    const packages: PackageDescriptor[] = [];

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
            : await discoverFilesPackage(entry.name, pkgPath, manifest);

        if (pkg) packages.push(pkg);
    }

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
): Promise<PackageDescriptor | null> {
    const files = manifest.files ?? [];
    if (files.length === 0) return null;

    // Check if all files are already installed (or use detect override for the files item)
    const filesItemName = files.join(", ");
    const filesDetect = manifest.detect?.[filesItemName];
    const allInstalled = filesDetect
        ? await checkDetect(filesDetect)
        : (await Promise.all(files.map((f) => exists(join(CLAUDE_DIR, f))))).every(Boolean);

    const filesDesc = `Files: ${files.join(", ")}\nInstall destination: ~/.claude/`;
    const exampleDesc = manifest.example ? `\nExample:\n  ${manifest.example}` : "";
    const items: PackageItem[] = [
        {
            name: files.join(", "),
            enabled: !allInstalled,
            alreadyInstalled: allInstalled,
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

/** Check if a skill is installed: exists in ~/.claude/skills/ (any symlink or directory). */
async function isSkillInstalled(name: string): Promise<boolean> {
    return exists(join(SKILLS_INSTALL_DIR, name));
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
        const settingsPath = join(CLAUDE_DIR, "settings.json");
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

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
