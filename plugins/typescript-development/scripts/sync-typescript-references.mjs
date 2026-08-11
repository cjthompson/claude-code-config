#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";


export const PINNED_COMMIT = "c8170c35bda4811c9516cbb69c39241ae4beb6d9";

const DOCUMENT_ROOT = "packages/documentation/copy/en";
const TSCONFIG_ROOT = "packages/tsconfig-reference/copy/en/options";

const HANDBOOK_FILES = [
    "Classes.md",
    "Everyday Types.md",
    "Modules.md",
    "More on Functions.md",
    "Narrowing.md",
    "Object Types.md",
    "Type Declarations.md",
    "Understanding Errors.md",
    "Type Manipulation/Conditional Types.md",
    "Type Manipulation/Generics.md",
    "Type Manipulation/Indexed Access Types.md",
    "Type Manipulation/Keyof Type Operator.md",
    "Type Manipulation/Mapped Types.md",
    "Type Manipulation/Template Literal Types.md",
    "Type Manipulation/Typeof Type Operator.md",
    "Type Manipulation/_Creating Types from Types.md",
];

const MODULE_FILES = [
    "Introduction.md",
    "Reference.md",
    "Theory.md",
    "appendices/ESM-CJS-Interop.md",
    "guides/Choosing Compiler Options.md",
];

const DECLARATION_FILES = [
    "By Example.md",
    "Do's and Don'ts.md",
    "Library Structures.md",
    "Publishing.md",
];

const TSCONFIG_FILES = [
    "allowImportingTsExtensions.md",
    "composite.md",
    "customConditions.md",
    "declaration.md",
    "declarationMap.md",
    "emitDeclarationOnly.md",
    "esModuleInterop.md",
    "exactOptionalPropertyTypes.md",
    "incremental.md",
    "isolatedDeclarations.md",
    "isolatedModules.md",
    "lib.md",
    "module.md",
    "moduleResolution.md",
    "noEmit.md",
    "noImplicitAny.md",
    "noImplicitOverride.md",
    "noUncheckedIndexedAccess.md",
    "outDir.md",
    "paths.md",
    "resolvePackageJsonExports.md",
    "resolvePackageJsonImports.md",
    "rewriteRelativeImportExtensions.md",
    "rootDir.md",
    "skipLibCheck.md",
    "strict.md",
    "strictFunctionTypes.md",
    "strictNullChecks.md",
    "target.md",
    "types.md",
    "useUnknownInCatchVariables.md",
    "verbatimModuleSyntax.md",
];

const DOWNLOADS = [
    ...HANDBOOK_FILES.map((name) => ({
        source: `${DOCUMENT_ROOT}/handbook-v2/${name}`,
        target: `typescript-website/handbook-v2/${name}`,
    })),
    ...MODULE_FILES.map((name) => ({
        source: `${DOCUMENT_ROOT}/modules-reference/${name}`,
        target: `typescript-website/modules-reference/${name}`,
    })),
    ...DECLARATION_FILES.map((name) => ({
        source: `${DOCUMENT_ROOT}/declaration-files/${name}`,
        target: `typescript-website/declaration-files/${name}`,
    })),
    ...TSCONFIG_FILES.map((name) => ({
        source: `${TSCONFIG_ROOT}/${name}`,
        target: `typescript-website/tsconfig/${name}`,
    })),
    { source: "LICENSE", target: "licenses/TypeScript-Website-CC-BY-4.0.txt" },
];

export const EXPECTED_REFERENCE_FILES = DOWNLOADS.map(({ target }) => target).sort();

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const VENDOR_ROOT = join(PLUGIN_ROOT, "vendor");


export function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}


export function assertImmutableCommit(ref) {
    if (typeof ref !== "string" || !/^[0-9a-f]{40}$/.test(ref)) {
        throw new Error("reference must be a lowercase 40-character commit SHA");
    }
    return ref;
}


export function validateReferenceInventory(fileNames, expected = EXPECTED_REFERENCE_FILES) {
    const actualSet = new Set(fileNames);
    const expectedSet = new Set(expected);
    const missing = expected.filter((name) => !actualSet.has(name));
    const unexpected = [...actualSet].filter((name) => !expectedSet.has(name)).sort();
    const problems = [];
    if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length > 0) problems.push(`unexpected: ${unexpected.join(", ")}`);
    if (actualSet.size !== fileNames.length) problems.push("duplicate file names");
    if (problems.length > 0) throw new Error(problems.join("; "));
}


async function exists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}


async function listFiles(root, prefix = "") {
    const result = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const path = join(prefix, entry.name);
        if (entry.isDirectory()) result.push(...await listFiles(root, path));
        else if (path !== "upstreams.json") result.push(path);
    }
    return result.sort();
}


async function backupPaths(destination) {
    const parent = dirname(destination);
    const prefix = `${basename(destination)}.backup-`;
    if (!await exists(parent)) return [];
    return (await readdir(parent))
        .filter((name) => name.startsWith(prefix))
        .map((name) => join(parent, name))
        .sort();
}


export async function recoverInterruptedInstall(destination) {
    if (await exists(destination)) return;
    const backups = await backupPaths(destination);
    if (backups.length === 0) return;
    if (backups.length > 1) {
        throw new Error(`multiple interrupted-install backups for ${destination}`);
    }
    await rename(backups[0], destination);
}


async function removeStaleBackups(destination) {
    for (const backup of await backupPaths(destination)) {
        await rm(backup, { recursive: true });
    }
}


export async function verifySnapshot(root = VENDOR_ROOT, expected = EXPECTED_REFERENCE_FILES) {
    await recoverInterruptedInstall(root);
    const manifest = JSON.parse(await readFile(join(root, "upstreams.json"), "utf8"));
    const source = manifest.sources?.["microsoft/TypeScript-Website"];
    assertImmutableCommit(source?.ref);
    assertImmutableCommit(source?.commit);
    if (source.ref !== source.commit) throw new Error("source ref and commit must match");
    if (source.license !== "CC-BY-4.0") throw new Error("unexpected documentation license");

    validateReferenceInventory(Object.keys(manifest.files).sort(), expected);
    validateReferenceInventory(await listFiles(root), expected);
    for (const [fileName, expectedHash] of Object.entries(manifest.files)) {
        const content = await readFile(join(root, fileName));
        if (sha256(content) !== expectedHash) throw new Error(`hash mismatch: ${fileName}`);
    }
    await removeStaleBackups(root);
}


export async function installSnapshot(staged, destination, validate) {
    await recoverInterruptedInstall(destination);
    await validate(staged);
    const backup = `${destination}.backup-${process.pid}`;
    const hadDestination = await exists(destination);
    if (hadDestination) await rename(destination, backup);
    try {
        await rename(staged, destination);
    } catch (error) {
        if (hadDestination && await exists(backup)) await rename(backup, destination);
        throw error;
    }
    if (hadDestination) await rm(backup, { recursive: true });
}


async function fetchText(url) {
    const response = await fetch(url, {
        headers: { "User-Agent": "claude-code-config-typescript-reference-sync" },
    });
    if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
    return response.text();
}


async function createSnapshot(root) {
    const commit = assertImmutableCommit(PINNED_COMMIT);
    const hashes = {};
    for (const { source, target } of DOWNLOADS) {
        const url = `https://raw.githubusercontent.com/microsoft/TypeScript-Website/${commit}/${source.split("/").map(encodeURIComponent).join("/")}`;
        const content = await fetchText(url);
        await mkdir(dirname(join(root, target)), { recursive: true });
        await writeFile(join(root, target), content);
        hashes[target] = sha256(content);
    }
    const manifest = {
        version: 1,
        sources: {
            "microsoft/TypeScript-Website": {
                ref: commit,
                commit,
                paths: [
                    `${DOCUMENT_ROOT}/handbook-v2`,
                    `${DOCUMENT_ROOT}/modules-reference`,
                    `${DOCUMENT_ROOT}/declaration-files`,
                    TSCONFIG_ROOT,
                ],
                license: "CC-BY-4.0",
            },
        },
        files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))),
    };
    await writeFile(join(root, "upstreams.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}


function parseArguments(argv) {
    if (argv.length === 0) return "refresh";
    if (argv.length === 1 && argv[0] === "--check") return "check";
    throw new Error("usage: sync-typescript-references.mjs [--check]");
}


async function main() {
    const mode = parseArguments(process.argv.slice(2));
    if (mode === "check") {
        await verifySnapshot();
        console.log(`Verified ${relative(process.cwd(), VENDOR_ROOT)}`);
        return;
    }

    const temporaryParent = await mkdtemp(join(PLUGIN_ROOT, ".vendor-staging-"));
    const staged = join(temporaryParent, "vendor");
    await mkdir(staged);
    try {
        await createSnapshot(staged);
        await installSnapshot(staged, VENDOR_ROOT, verifySnapshot);
        console.log(`Updated ${relative(process.cwd(), VENDOR_ROOT)}`);
    } finally {
        await rm(temporaryParent, { recursive: true, force: true });
    }
}


if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
