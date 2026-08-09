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


export const EXPECTED_SPEC_FILES = [
    "aliases.rst",
    "annotations.rst",
    "callables.rst",
    "class-compat.rst",
    "concepts.rst",
    "constructors.rst",
    "dataclasses.rst",
    "directives.rst",
    "distributing.rst",
    "enums.rst",
    "exceptions.rst",
    "generics.rst",
    "glossary.rst",
    "historical.rst",
    "index.rst",
    "literal.rst",
    "meta.rst",
    "namedtuples.rst",
    "narrowing.rst",
    "overload.rst",
    "protocol.rst",
    "qualifiers.rst",
    "special-types.rst",
    "tuples.rst",
    "type-forms.rst",
    "type-system.rst",
    "typeddict.rst",
];

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const VENDOR_ROOT = join(PLUGIN_ROOT, "vendor");


export function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}


export function validateSpecInventory(fileNames) {
    const actual = new Set(fileNames);
    const expected = new Set(EXPECTED_SPEC_FILES);
    const missing = EXPECTED_SPEC_FILES.filter((name) => !actual.has(name));
    const unexpected = [...actual].filter((name) => !expected.has(name)).sort();

    const problems = [];
    if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length > 0) problems.push(`unexpected: ${unexpected.join(", ")}`);
    if (actual.size !== fileNames.length) problems.push("duplicate file names");
    if (problems.length > 0) throw new Error(problems.join("; "));
}


export async function verifySnapshot(root = VENDOR_ROOT) {
    await recoverInterruptedInstall(root);
    const manifest = JSON.parse(await readFile(join(root, "upstreams.json"), "utf8"));
    for (const [fileName, expectedHash] of Object.entries(manifest.files)) {
        const content = await readFile(join(root, fileName));
        if (sha256(content) !== expectedHash) {
            throw new Error(`hash mismatch: ${fileName}`);
        }
    }
    validateSpecInventory(await readdir(join(root, "typing-spec")));
    await removeStaleBackups(root);
}


async function exists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
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
        headers: { "User-Agent": "claude-code-config-reference-sync" },
    });
    if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
    return response.text();
}


async function resolveCommit(repository, ref) {
    const payload = JSON.parse(
        await fetchText(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`),
    );
    if (typeof payload.sha !== "string" || !/^[0-9a-f]{40}$/.test(payload.sha)) {
        throw new Error(`invalid commit response for ${repository}@${ref}`);
    }
    return payload.sha;
}


async function writeDownloaded(root, fileName, url, hashes) {
    const content = await fetchText(url);
    const destination = join(root, fileName);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    hashes[fileName] = sha256(content);
}


async function createSnapshot(root, { typingRef, tightenRef }) {
    const typingCommit = await resolveCommit("python/typing", typingRef);
    const tightenCommit = await resolveCommit("honnibal/claude-skills", tightenRef);
    const hashes = {};

    for (const fileName of EXPECTED_SPEC_FILES) {
        await writeDownloaded(
            root,
            `typing-spec/${fileName}`,
            `https://raw.githubusercontent.com/python/typing/${typingCommit}/docs/spec/${fileName}`,
            hashes,
        );
    }
    await writeDownloaded(
        root,
        "tighten-types/tighten-types.md.txt",
        `https://raw.githubusercontent.com/honnibal/claude-skills/${tightenCommit}/tighten-types.md.txt`,
        hashes,
    );
    await writeDownloaded(
        root,
        "licenses/python-typing-PSF.txt",
        `https://raw.githubusercontent.com/python/typing/${typingCommit}/LICENSE`,
        hashes,
    );
    await writeDownloaded(
        root,
        "licenses/honnibal-claude-skills-MIT.txt",
        `https://raw.githubusercontent.com/honnibal/claude-skills/${tightenCommit}/LICENSE`,
        hashes,
    );

    const manifest = {
        version: 1,
        sources: {
            "python/typing": {
                ref: typingRef,
                commit: typingCommit,
                path: "docs/spec",
                license: "PSF-2.0",
            },
            "honnibal/claude-skills": {
                ref: tightenRef,
                commit: tightenCommit,
                path: "tighten-types.md.txt",
                license: "MIT",
            },
        },
        files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))),
    };
    await writeFile(join(root, "upstreams.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}


function parseArguments(argv) {
    const options = { mode: "check", typingRef: "main", tightenRef: "main" };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--check") options.mode = "check";
        else if (argument === "--refresh") options.mode = "refresh";
        else if (argument === "--typing-ref") options.typingRef = argv[++index];
        else if (argument === "--tighten-ref") options.tightenRef = argv[++index];
        else throw new Error(`unknown argument: ${argument}`);
    }
    if (!options.typingRef || !options.tightenRef) throw new Error("missing ref value");
    return options;
}


async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.mode === "check") {
        await verifySnapshot();
        console.log(`Verified ${relative(process.cwd(), VENDOR_ROOT)}`);
        return;
    }

    const temporaryParent = await mkdtemp(join(PLUGIN_ROOT, ".vendor-staging-"));
    const staged = join(temporaryParent, "vendor");
    await mkdir(staged);
    try {
        await createSnapshot(staged, options);
        await mkdir(dirname(VENDOR_ROOT), { recursive: true });
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
