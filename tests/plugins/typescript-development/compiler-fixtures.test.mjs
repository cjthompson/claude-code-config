import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = join(ROOT, "tests/plugins/typescript-development/fixtures");
const TSC = join(ROOT, "node_modules/.bin/tsc");


function tsc(args, cwd) {
    return spawnSync(TSC, args, { cwd, encoding: "utf8" });
}


function assertTscPasses(args, cwd) {
    const result = tsc(args, cwd);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}


test("strict fixture checks positive and expected-error type contracts", () => {
    assertTscPasses(["-p", join(FIXTURES, "strict-types/tsconfig.json")], ROOT);
});


test("NodeNext rejects extensionless relative ESM imports", () => {
    const fixture = join(FIXTURES, "node-invalid-extension");
    const result = tsc(["-p", "tsconfig.json"], fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /explicit file extensions/);
});


test("bundler resolution accepts the same extensionless source import", () => {
    assertTscPasses(["-p", join(FIXTURES, "bundler-resolution/tsconfig.json")], ROOT);
});


test("built ESM package emits declarations and compiles as an installed consumer", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "typescript-package-consumer-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const library = join(root, "library");
    const consumer = join(root, "consumer");
    await cp(join(FIXTURES, "esm-library"), library, { recursive: true });
    await cp(join(FIXTURES, "esm-consumer"), consumer, { recursive: true });

    assertTscPasses(["-p", "tsconfig.json"], library);
    assert.equal((await stat(join(library, "dist/index.d.ts"))).isFile(), true);
    assert.match(await readFile(join(library, "dist/index.d.ts"), "utf8"), /export declare function greet/);

    const installed = join(consumer, "node_modules/fixture-package");
    await mkdir(dirname(installed), { recursive: true });
    await cp(library, installed, {
        recursive: true,
        filter: (source) => !source.includes("/src") && !source.endsWith("tsconfig.json"),
    });
    assertTscPasses(["-p", "tsconfig.json"], consumer);
});


test("composite project references build in dependency order", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "typescript-project-references-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(FIXTURES, "project-references"), root, { recursive: true });
    assertTscPasses(["-b", "tsconfig.json"], root);
    assert.equal((await stat(join(root, "packages/core/dist/index.d.ts"))).isFile(), true);
    assert.equal((await stat(join(root, "packages/app/dist/index.js"))).isFile(), true);
});
