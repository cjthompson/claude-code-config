// Read-only install-time check for a configured `outputStyle` that resolves to
// nothing. Claude Code does not error on an unresolvable style name — it records
// the value, injects no style prompt, and runs with default behavior, so a typo
// here is invisible until someone diffs a transcript.
//
// Every function in this module is read-only by construction: the only
// `node:fs/promises` imports are `readFile`, `readdir`, and `readlink`.
import { readFile, readdir, readlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { InstallResult } from "./types.ts";

/** Directory name used for style files under both a plugin and `<claudeDir>`. */
const STYLE_DIR = "output-styles";

/** Styles Claude Code provides itself — no file on disk, no plugin prefix. */
export const BUILTIN_STYLE_NAMES: readonly string[] = [
    "default",
    "Concise",
    "Explanatory",
    "Learning",
];

export interface ConfiguredStyle {
    /** Absolute path of the settings file the value came from */
    source: string;
    value: string;
}

export interface AvailableStyles {
    /** `<plugin-dir>:<frontmatter name>` for each plugins/*\/output-styles/*.md */
    plugin: string[];
    /** Unprefixed frontmatter names from `<claudeDir>/output-styles/*.md` */
    user: string[];
    /** Claude Code's own style names */
    builtin: string[];
}

export interface PluginStyle {
    /** `plugins/<plugin>` directory name — the prefix Claude Code applies */
    plugin: string;
    /** File basename; never the source of the style name */
    file: string;
    /** Absolute path of the source file in the repo */
    path: string;
    /** Frontmatter `name:` value */
    styleName: string;
    /** `<plugin>:<styleName>` — the only name that resolves */
    qualifiedName: string;
}

export interface UserStyle {
    file: string;
    path: string;
    styleName: string;
}

/** A style file the retired file-copy install route would have left behind. */
export interface StaleStyleCopy {
    /** Absolute path of the copy under `<claudeDir>/output-styles/` */
    path: string;
    /** Unprefixed name the copy manufactures */
    bareName: string;
    /** The prefixed name that should be used instead */
    canonicalName: string;
    /** Resolved target when the copy is a symbolic link, else null */
    linkTarget: string | null;
    /** True when `linkTarget` points back into the checkout */
    linksIntoRepo: boolean;
}

export type StyleVerdict =
    | { kind: "resolves"; configured: ConfiguredStyle }
    | { kind: "ambiguous"; configured: ConfiguredStyle; shadowed: string[] }
    | {
        kind: "unresolved";
        configured: ConfiguredStyle;
        suggestion: string | null;
        available: string[];
    };

/**
 * Frontmatter `name:` of an output-style file, or null. Mirrors the parsing
 * shape of `extractSkillDescription` in discover.ts rather than pulling in a
 * YAML dependency.
 */
export function parseStyleName(content: string): string | null {
    if (!content.startsWith("---")) return null;
    const end = content.indexOf("\n---", 3);
    if (end === -1) return null;
    const frontmatter = content.slice(3, end);
    const match = frontmatter.match(/^name:\s*(.+)$/m);
    if (!match) return null;
    const name = match[1]!.trim().replace(/^["']|["']$/g, "").trim();
    return name.length > 0 ? name : null;
}

/** Deduped, deterministically ordered union of every resolvable style name. */
export function allStyleNames(available: AvailableStyles): string[] {
    const seen = new Set<string>();
    for (const name of [...available.builtin, ...available.user, ...available.plugin]) {
        if (name) seen.add(name);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Closest available name for an unresolvable value, by fixed precedence — no
 * edit distance. Rule 1 alone covers `Terse` -> `output-styles:Terse`.
 */
export function suggestStyleName(configured: string, available: string[]): string | null {
    const lower = configured.trim().toLowerCase();
    if (lower === "") return null;

    // 1. suffix after the colon, case-insensitive
    for (const name of available) {
        const colon = name.indexOf(":");
        if (colon !== -1 && name.slice(colon + 1).toLowerCase() === lower) return name;
    }
    // 2. case-insensitive exact — wrong casing only
    for (const name of available) {
        if (name.toLowerCase() === lower) return name;
    }
    // 3. prefix of the full name or of its suffix after the colon
    for (const name of available) {
        const colon = name.indexOf(":");
        const suffix = colon === -1 ? name : name.slice(colon + 1);
        if (name.toLowerCase().startsWith(lower) || suffix.toLowerCase().startsWith(lower)) {
            return name;
        }
    }
    // 4. caller lists `available` instead
    return null;
}

/**
 * Pure core: classify each configured value against the available names.
 *
 * Three outcomes, not two. Built-in `Concise` shadows the plugin's `Concise`,
 * so a bare `"Concise"` genuinely resolves while a bare `"Terse"` does not — a
 * "missing from the plugin list" rule would report working config as broken.
 */
export function checkOutputStyle(
    configured: ConfiguredStyle[],
    available: AvailableStyles,
): StyleVerdict[] {
    const names = allStyleNames(available);

    return configured.map((entry) => {
        if (!names.includes(entry.value)) {
            return {
                kind: "unresolved" as const,
                configured: entry,
                suggestion: suggestStyleName(entry.value, names),
                available: names,
            };
        }
        // An unprefixed name that a plugin also publishes is served by the
        // built-in or user-level copy; the plugin's style is never reached.
        if (!entry.value.includes(":")) {
            const shadowed = names.filter(
                (name) =>
                    name.includes(":") && name.slice(name.indexOf(":") + 1) === entry.value,
            );
            if (shadowed.length > 0) {
                return { kind: "ambiguous" as const, configured: entry, shadowed };
            }
        }
        return { kind: "resolves" as const, configured: entry };
    });
}

/** Settings files the installer is allowed to read — never a filesystem walk. */
export function configuredStyleSources(repoRoot: string, claudeDir: string): string[] {
    return [
        join(claudeDir, "settings.json"),
        join(repoRoot, ".claude", "settings.json"),
        join(repoRoot, ".claude", "settings.local.json"),
    ];
}

export function defaultClaudeDir(): string {
    return join(process.env.HOME ?? "", ".claude");
}

async function readText(path: string): Promise<string> {
    try {
        return await readFile(path, "utf-8");
    } catch {
        return "";
    }
}

/** Markdown entries of `dir`, sorted; empty when `dir` is absent. */
async function listStyleFiles(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md"))
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }
}

/** Resolved target of a link, or null when `path` is not one. */
async function readLinkTarget(path: string): Promise<string | null> {
    try {
        return resolve(path, "..", await readlink(path));
    } catch {
        return null;
    }
}

export async function listPluginStyles(repoRoot: string): Promise<PluginStyle[]> {
    const pluginsDir = join(repoRoot, "plugins");
    let plugins: string[];
    try {
        plugins = (await readdir(pluginsDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }

    const found: PluginStyle[] = [];
    for (const plugin of plugins) {
        const styleDir = join(pluginsDir, plugin, STYLE_DIR);
        for (const file of await listStyleFiles(styleDir)) {
            const path = join(styleDir, file);
            const styleName = parseStyleName(await readText(path));
            if (!styleName) continue;
            found.push({
                plugin,
                file,
                path,
                styleName,
                qualifiedName: `${plugin}:${styleName}`,
            });
        }
    }
    return found;
}

export async function listUserStyles(claudeDir: string): Promise<UserStyle[]> {
    const styleDir = join(claudeDir, STYLE_DIR);
    const found: UserStyle[] = [];
    for (const file of await listStyleFiles(styleDir)) {
        const path = join(styleDir, file);
        const styleName = parseStyleName(await readText(path));
        if (!styleName) continue;
        found.push({ file, path, styleName });
    }
    return found;
}

export async function enumerateAvailableStyles(
    repoRoot: string,
    claudeDir: string,
): Promise<AvailableStyles> {
    const [pluginStyles, userStyles] = await Promise.all([
        listPluginStyles(repoRoot),
        listUserStyles(claudeDir),
    ]);
    return {
        plugin: pluginStyles.map((style) => style.qualifiedName),
        user: userStyles.map((style) => style.styleName),
        builtin: [...BUILTIN_STYLE_NAMES],
    };
}

export async function readConfiguredStyles(
    repoRoot: string,
    claudeDir: string,
): Promise<ConfiguredStyle[]> {
    const found: ConfiguredStyle[] = [];
    for (const source of configuredStyleSources(repoRoot, claudeDir)) {
        let value: unknown;
        try {
            const parsed = JSON.parse(await readFile(source, "utf-8")) as Record<string, unknown>;
            value = parsed.outputStyle;
        } catch {
            // Absent, empty, or malformed — same posture as install.ts:301-306
            continue;
        }
        if (typeof value === "string" && value.trim() !== "") {
            found.push({ source, value });
        }
    }
    return found;
}

/**
 * Style files the retired `installFiles` route would have copied into
 * `<claudeDir>/output-styles/`. Paths are derived from the repo, never
 * hardcoded. Reports only — removal is the user's call.
 */
export async function findStaleStyleCopies(
    repoRoot: string,
    claudeDir: string,
): Promise<StaleStyleCopy[]> {
    const pluginStyles = await listPluginStyles(repoRoot);
    if (pluginStyles.length === 0) return [];

    const installDir = join(claudeDir, STYLE_DIR);
    let present: Map<string, boolean>;
    try {
        const entries = await readdir(installDir, { withFileTypes: true });
        present = new Map(entries.map((entry) => [entry.name, entry.isSymbolicLink()]));
    } catch {
        return [];
    }

    const found: StaleStyleCopy[] = [];
    for (const style of pluginStyles) {
        // The destination `installFiles` used: join(claudeDir, manifest file path)
        const isLink = present.get(style.file);
        if (isLink === undefined) continue;

        const path = join(installDir, style.file);
        const target = isLink ? await readLinkTarget(path) : null;
        found.push({
            path,
            bareName: parseStyleName(await readText(path)) ?? style.styleName,
            canonicalName: style.qualifiedName,
            linkTarget: target,
            linksIntoRepo: target !== null && target.startsWith(repoRoot + "/"),
        });
    }
    return found;
}

/** Pure: turn verdicts into installer results. Resolving values emit nothing. */
export function formatVerdicts(
    verdicts: StyleVerdict[],
    stale: StaleStyleCopy[],
): InstallResult[] {
    const results: InstallResult[] = [];

    for (const verdict of verdicts) {
        const { source, value } = verdict.configured;
        if (verdict.kind === "resolves") continue;

        if (verdict.kind === "ambiguous") {
            results.push({
                packageId: "output-style-check",
                itemName: value,
                status: "warning",
                message:
                    `outputStyle "${value}" (${source}) resolves to the unprefixed style; ` +
                    `${verdict.shadowed.map((n) => `"${n}"`).join(", ")} also exists and is ` +
                    `not what you get. Use the prefixed name if you meant the plugin style.`,
            });
            continue;
        }

        const tail = verdict.suggestion
            ? `Did you mean "${verdict.suggestion}"?`
            : `Available: ${verdict.available.join(", ")}`;
        results.push({
            packageId: "output-style-check",
            itemName: value,
            status: "warning",
            message:
                `outputStyle "${value}" (${source}) matches no available style — Claude Code ` +
                `silently runs the default. ${tail} Edit the file by hand; this check never writes.`,
        });
    }

    for (const copy of stale) {
        const kind = copy.linksIntoRepo
            ? "symbolic link into this checkout"
            : copy.linkTarget !== null
                ? `symbolic link to ${copy.linkTarget}`
                : "file copy";
        results.push({
            packageId: "output-style-check",
            itemName: basename(copy.path),
            status: "warning",
            message:
                `Stale ${kind} ${copy.path} publishes the unprefixed style name ` +
                `"${copy.bareName}"; the canonical name is "${copy.canonicalName}". ` +
                `Left in place — remove it yourself with: rm ${copy.path}`,
        });
    }

    return results;
}

/**
 * Read-only post-install check. Never throws and never reports `error`, so it
 * cannot flip an installer exit code.
 */
export async function runOutputStyleCheck(
    repoRoot: string,
    claudeDir: string = defaultClaudeDir(),
): Promise<InstallResult[]> {
    try {
        const [available, configured, stale] = await Promise.all([
            enumerateAvailableStyles(repoRoot, claudeDir),
            readConfiguredStyles(repoRoot, claudeDir),
            findStaleStyleCopies(repoRoot, claudeDir),
        ]);
        return formatVerdicts(checkOutputStyle(configured, available), stale);
    } catch {
        return [];
    }
}
