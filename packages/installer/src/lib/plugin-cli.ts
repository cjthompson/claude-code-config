import { execFile } from "node:child_process";

/**
 * The single place the `claude plugin ...` command line is constructed.
 *
 * Plugins are installed by invoking the real Claude Code CLI, never by copying
 * files into ~/.claude/. Copying produces a second, unprefixed identifier for
 * the same asset (a plugin style `output-styles:Terse` also showing up as a bare
 * `Terse`), which is the defect this module exists to prevent. There is
 * deliberately no file-copy fallback anywhere in this path.
 *
 * Verified against claude v2.1.274: the `plugin` subcommands are install|i,
 * uninstall|remove, update, enable, disable, list, details, validate, init|new,
 * prune, tag, eval, and marketplace {add,list,remove,update}. There is no
 * `plugin add`.
 */

/** Subcommand namespace. Defined once so no other module spells it. */
const PLUGIN_CMD = "plugin";

/** Binary to invoke. Overridable for unusual PATHs and for tests. */
export function claudeBin(): string {
    return process.env.CLAUDE_BIN ?? "claude";
}

/**
 * Scope every install uses. `user` writes enabledPlugins and
 * extraKnownMarketplaces into ~/.claude/settings.json, which is what the
 * previous copy-based route was approximating.
 */
export const INSTALL_SCOPE = "user" as const;

/** `<plugin>@<marketplace>` — the only form `plugin install` accepts. Not a path. */
export function pluginId(name: string, marketplace: string): string {
    return `${name}@${marketplace}`;
}

export function versionArgv(): string[] {
    return ["--version"];
}

export function pluginInstallArgv(id: string): string[] {
    return [PLUGIN_CMD, "install", id, "--scope", INSTALL_SCOPE, "--yes", "--json"];
}

export function pluginUpdateArgv(id: string): string[] {
    return [PLUGIN_CMD, "update", id, "--scope", INSTALL_SCOPE, "--yes", "--json"];
}

export function pluginUninstallArgv(id: string): string[] {
    return [PLUGIN_CMD, "uninstall", id, "--scope", INSTALL_SCOPE, "--yes", "--json"];
}

export function pluginListArgv(): string[] {
    return [PLUGIN_CMD, "list", "--json"];
}

export function marketplaceListArgv(): string[] {
    return [PLUGIN_CMD, "marketplace", "list", "--json"];
}

export interface SpawnResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Injectable process runner. Tests supply a recorder to assert argv without
 * executing anything.
 */
export type Spawn = (bin: string, argv: string[]) => Promise<SpawnResult>;

/**
 * Default runner.
 *
 * execFile with an argv array — never a shell, so a plugin name can't be
 * injected. Output is captured, never inherited: this path is reachable from the
 * Ink render, and inherited stdio corrupts it.
 *
 * A missing binary rejects (ENOENT) so callers can tell "claude isn't
 * installed" apart from "the command failed".
 */
export const realSpawn: Spawn = (bin, argv) =>
    new Promise((resolvePromise, rejectPromise) => {
        execFile(
            bin,
            argv,
            { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
                    rejectPromise(err);
                    return;
                }
                const rawCode = (err as { code?: unknown } | null)?.code;
                const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
                resolvePromise({
                    code,
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                });
            },
        );
    });

/** True when a thrown error means the `claude` binary is not on PATH. */
export function isMissingBinary(err: unknown): boolean {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export interface InstalledPlugin {
    id: string;
    version: string;
    scope: string;
    enabled: boolean;
}

/**
 * Parse `plugin list --json`, keeping only entries at `scope` and deduping by id.
 *
 * The same id legitimately appears more than once — the same plugin installed at
 * both user and local scope, and occasionally twice at one scope. An
 * already-installed probe that ignores this misfires, so filter to the scope we
 * install with and keep the highest version.
 */
export function parsePluginList(
    stdout: string,
    scope: string = INSTALL_SCOPE,
): Map<string, InstalledPlugin> {
    const byId = new Map<string, InstalledPlugin>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return byId;
    }

    const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { plugins?: unknown })?.plugins)
          ? (parsed as { plugins: unknown[] }).plugins
          : [];

    for (const row of rows) {
        const entry = row as Partial<InstalledPlugin>;
        if (typeof entry?.id !== "string") continue;
        if (entry.scope !== scope) continue;

        const candidate: InstalledPlugin = {
            id: entry.id,
            version: typeof entry.version === "string" ? entry.version : "",
            scope: entry.scope,
            enabled: entry.enabled !== false,
        };
        const existing = byId.get(candidate.id);
        if (!existing || compareVersions(candidate.version, existing.version) > 0) {
            byId.set(candidate.id, candidate);
        }
    }

    return byId;
}

/** Parse `plugin marketplace list --json` into name → source descriptor. */
export function parseMarketplaceList(
    stdout: string,
): Map<string, { source?: string; repo?: string }> {
    const byName = new Map<string, { source?: string; repo?: string }>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return byName;
    }

    const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { marketplaces?: unknown })?.marketplaces)
          ? (parsed as { marketplaces: unknown[] }).marketplaces
          : [];

    for (const row of rows) {
        const entry = row as { name?: unknown; source?: unknown; repo?: unknown };
        if (typeof entry?.name !== "string") continue;
        byName.set(entry.name, {
            source: typeof entry.source === "string" ? entry.source : undefined,
            repo: typeof entry.repo === "string" ? entry.repo : undefined,
        });
    }

    return byName;
}

/** Numeric-segment version compare. Returns >0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** Pull the human-facing failure text out of a `--json` result line. */
export function describeFailure(result: SpawnResult): string {
    for (const line of result.stdout.split("\n").reverse()) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
            const parsed = JSON.parse(trimmed) as {
                message?: unknown;
                failureCode?: unknown;
            };
            if (typeof parsed.message === "string" && parsed.message) {
                return typeof parsed.failureCode === "string"
                    ? `${parsed.message} (${parsed.failureCode})`
                    : parsed.message;
            }
        } catch {
            // Not the JSON result line — keep looking.
        }
    }
    const stderrLine = result.stderr
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
    return stderrLine ?? `exited ${result.code}`;
}

/**
 * Recovery text for a missing `claude` binary.
 *
 * Deliberately a message and not a fallback: copying the plugin's files instead
 * would silently recreate the duplicate-identifier bug.
 */
export function missingBinaryMessage(id: string, marketplaceSource: string): string {
    return (
        `claude CLI not found on PATH — cannot install ${id}. ` +
        `Run \`/plugin marketplace add ${marketplaceSource}\` then ` +
        `\`/plugin install ${id}\` from inside Claude Code.`
    );
}
