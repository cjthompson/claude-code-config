import { readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const pluginsDir = join(repoRoot, "plugins");

const entries = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(join(pluginsDir, e.name, ".claude-plugin", "plugin.json")));

if (entries.length === 0) {
    console.error("No plugins found in plugins/");
    process.exit(1);
}

let failed = 0;

for (const entry of entries) {
    const pluginPath = join(pluginsDir, entry.name);
    console.log(`Installing ${entry.name}...`);
    const result = spawnSync("claude", ["plugin", "add", pluginPath], { stdio: "inherit" });
    if (result.status !== 0) {
        console.error(`  Failed: ${entry.name} (exit ${result.status ?? "unknown"})`);
        failed++;
    }
}

if (failed > 0) {
    console.error(`\n${failed} plugin(s) failed to install.`);
    process.exit(1);
}

console.log(`\nAll ${entries.length} plugin(s) installed.`);
