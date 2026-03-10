import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPackages } from "./lib/discover.ts";
import { installPackage } from "./lib/install.ts";
import type { PackageDescriptor } from "./lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

async function main() {
    console.log("Discovering packages...");
    let packages: PackageDescriptor[];
    try {
        packages = await discoverPackages(repoRoot);
    } catch (err) {
        console.error("Failed to discover packages:", (err as Error).message);
        process.exit(1);
    }

    // Find packages that have at least one already-installed item
    const toReinstall = packages
        .map((pkg) => ({
            ...pkg,
            items: pkg.items
                .filter((item) => item.alreadyInstalled)
                .map((item) => ({ ...item, enabled: true })),
        }))
        .filter((pkg) => pkg.items.length > 0);

    if (toReinstall.length === 0) {
        console.log("No installed packages found to reinstall.");
        process.exit(0);
    }

    console.log(
        `Reinstalling ${toReinstall.reduce((n, p) => n + p.items.length, 0)} item(s) across ${toReinstall.length} package(s)...\n`,
    );

    let hasError = false;
    for (const pkg of toReinstall) {
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
        console.error("Reinstall completed with errors.");
        process.exit(1);
    }
    console.log("Reinstall complete.");
    process.exit(0);
}

main();
