import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPackages } from "./lib/discover.ts";
import { installPackage } from "./lib/install.ts";
import type { PackageDescriptor } from "./lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

async function main() {
    console.log("Discovering plugins...");
    let packages: PackageDescriptor[];
    try {
        packages = await discoverPackages(repoRoot);
    } catch (err) {
        console.error("Failed to discover packages:", (err as Error).message);
        process.exit(1);
    }

    const plugins = packages
        .filter((pkg) => pkg.type === "plugin")
        .map((pkg) => ({
            ...pkg,
            items: pkg.items.map((item) => ({ ...item, enabled: true })),
        }));

    if (plugins.length === 0) {
        console.error("No plugins found in plugins/.");
        process.exit(1);
    }

    console.log(`Installing ${plugins.length} plugin(s) via the Claude Code CLI...\n`);

    let hasError = false;
    for (const pkg of plugins) {
        console.log(`[${pkg.label}]`);
        try {
            const results = await installPackage(pkg);
            for (const result of results) {
                const prefix = result.status === "error" ? "  ERROR" : "  OK   ";
                console.log(`${prefix}  ${result.message}`);
                if (result.status === "error") hasError = true;
            }
        } catch (err) {
            console.error(`  ERROR  ${pkg.label}: ${(err as Error).message}`);
            hasError = true;
        }
        console.log();
    }

    if (hasError) {
        console.error("Plugin install completed with errors.");
        process.exit(1);
    }
    console.log("Plugin install complete. Restart Claude Code to apply.");
    process.exit(0);
}

main();
