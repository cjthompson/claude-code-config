import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPackages } from "./lib/discover.ts";
import { installPackage } from "./lib/install.ts";
import type { PackageDescriptor } from "./lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

async function main() {
    const names = process.argv.slice(2);

    if (names.length === 0) {
        console.error("Usage: install-package <name> [<name> ...]");
        console.error("  <name>  Package or skill name to install (case-insensitive)");
        process.exit(1);
    }

    const normalizedNames = names.map((n) => n.toLowerCase());

    console.log("Discovering packages...");
    let packages: PackageDescriptor[];
    try {
        packages = await discoverPackages(repoRoot);
    } catch (err) {
        console.error("Failed to discover packages:", (err as Error).message);
        process.exit(1);
    }

    // Match packages by top-level id or label, and items by item name — case-insensitive.
    // For each requested name, we look for:
    //   1. A top-level package whose id or label matches → install all items in that package
    //   2. An individual item whose name matches within any package → install only that item
    const matched: PackageDescriptor[] = [];
    const unmatchedNames = new Set(normalizedNames);

    for (const name of normalizedNames) {
        // Try top-level package match first
        const pkgMatch = packages.find(
            (p) => p.id.toLowerCase() === name || p.label.toLowerCase() === name,
        );
        if (pkgMatch) {
            // Install all items in this package (mark all as enabled)
            matched.push({
                ...pkgMatch,
                items: pkgMatch.items.map((item) => ({ ...item, enabled: true })),
            });
            unmatchedNames.delete(name);
            continue;
        }

        // Try individual item match across all packages
        for (const pkg of packages) {
            const matchingItems = pkg.items.filter(
                (item) => item.name.toLowerCase() === name,
            );
            if (matchingItems.length > 0) {
                // Add a synthetic package descriptor with only the matching items
                const existing = matched.find((m) => m.id === pkg.id);
                if (existing) {
                    existing.items.push(
                        ...matchingItems.map((item) => ({ ...item, enabled: true })),
                    );
                } else {
                    matched.push({
                        ...pkg,
                        items: matchingItems.map((item) => ({ ...item, enabled: true })),
                    });
                }
                unmatchedNames.delete(name);
            }
        }
    }

    if (unmatchedNames.size > 0) {
        const list = [...unmatchedNames].join(", ");
        console.error(`Package(s) not found: ${list}`);
        console.error("\nAvailable packages and items:");
        for (const pkg of packages) {
            console.error(`  ${pkg.id} (${pkg.label})`);
            for (const item of pkg.items) {
                console.error(`    - ${item.name}`);
            }
        }
        process.exit(1);
    }

    const totalItems = matched.reduce((n, p) => n + p.items.length, 0);
    console.log(
        `Installing ${totalItems} item(s) across ${matched.length} package(s)...\n`,
    );

    let hasError = false;
    for (const pkg of matched) {
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
        console.error("Install completed with errors.");
        process.exit(1);
    }
    console.log("Install complete.");
    process.exit(0);
}

main();
