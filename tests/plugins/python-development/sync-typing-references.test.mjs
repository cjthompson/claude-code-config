import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    EXPECTED_SPEC_FILES,
    installSnapshot,
    recoverInterruptedInstall,
    sha256,
    validateSpecInventory,
    verifySnapshot,
} from "../../../plugins/python-development/scripts/sync-typing-references.mjs";

const VENDOR_ROOT = new URL(
    "../../../plugins/python-development/vendor/",
    import.meta.url,
);

const APPROVED_SPEC_FILES = [
    "aliases.rst", "annotations.rst", "callables.rst", "class-compat.rst",
    "concepts.rst", "constructors.rst", "dataclasses.rst", "directives.rst",
    "distributing.rst", "enums.rst", "exceptions.rst", "generics.rst",
    "glossary.rst", "historical.rst", "index.rst", "literal.rst", "meta.rst",
    "namedtuples.rst", "narrowing.rst", "overload.rst", "protocol.rst",
    "qualifiers.rst", "special-types.rst", "tuples.rst", "type-forms.rst",
    "type-system.rst", "typeddict.rst",
];


test("typing specification inventory accepts exactly the complete upstream tree", () => {
    assert.deepEqual(EXPECTED_SPEC_FILES, APPROVED_SPEC_FILES);
    assert.equal(APPROVED_SPEC_FILES.length, 27);
    assert.doesNotThrow(() => validateSpecInventory(APPROVED_SPEC_FILES));
    assert.throws(
        () => validateSpecInventory(EXPECTED_SPEC_FILES.slice(1)),
        /missing: aliases\.rst/,
    );
    assert.throws(
        () => validateSpecInventory([...EXPECTED_SPEC_FILES, "surprise.rst"]),
        /unexpected: surprise\.rst/,
    );
});

test("checked-in snapshot records the approved immutable commits", async () => {
    const manifest = JSON.parse(
        await readFile(new URL("upstreams.json", VENDOR_ROOT), "utf8"),
    );
    assert.equal(
        manifest.sources["python/typing"].commit,
        "fa0a78a67b2844561c0281f3b9e5eb9464e12750",
    );
    assert.equal(
        manifest.sources["honnibal/claude-skills"].commit,
        "882fe898acec52ddc39d074e12c7497ee96ed963",
    );
});

test("snapshot verification detects changed vendored content", async () => {
    const root = await mkdtemp(join(tmpdir(), "typing-snapshot-"));
    await mkdir(join(root, "typing-spec"));
    await writeFile(join(root, "reference.txt"), "original\n");
    for (const fileName of EXPECTED_SPEC_FILES) {
        await writeFile(join(root, "typing-spec", fileName), "");
    }
    const files = { "reference.txt": sha256("original\n") };
    for (const fileName of EXPECTED_SPEC_FILES) {
        files[`typing-spec/${fileName}`] = sha256("");
    }
    await writeFile(
        join(root, "upstreams.json"),
        JSON.stringify({ files }),
    );

    await assert.doesNotReject(() => verifySnapshot(root));
    await writeFile(join(root, "reference.txt"), "changed\n");
    await assert.rejects(() => verifySnapshot(root), /hash mismatch: reference\.txt/);
});

test("failed staged validation leaves the installed snapshot untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "typing-install-"));
    const destination = join(root, "vendor");
    const staged = join(root, "staged");
    await mkdir(destination);
    await mkdir(staged);
    await writeFile(join(destination, "marker.txt"), "installed\n");
    await writeFile(join(staged, "marker.txt"), "candidate\n");

    await assert.rejects(
        () => installSnapshot(staged, destination, async () => {
            throw new Error("invalid candidate");
        }),
        /invalid candidate/,
    );
    assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "installed\n");
});

test("successful replacement installs the candidate and removes its backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "typing-replace-"));
    const destination = join(root, "vendor");
    const staged = join(root, "staged");
    await mkdir(destination);
    await mkdir(staged);
    await writeFile(join(destination, "marker.txt"), "installed\n");
    await writeFile(join(staged, "marker.txt"), "candidate\n");

    await installSnapshot(staged, destination, async () => {});

    assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "candidate\n");
    assert.deepEqual(
        (await readdir(root)).filter((name) => name.startsWith("vendor.backup-")),
        [],
    );
});

test("a failed activation restores the installed snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "typing-rollback-"));
    const destination = join(root, "vendor");
    await mkdir(destination);
    await writeFile(join(destination, "marker.txt"), "installed\n");

    await assert.rejects(
        () => installSnapshot(join(root, "missing"), destination, async () => {}),
        /ENOENT/,
    );
    assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "installed\n");
});

test("an interrupted activation recovers the sole installed backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "typing-recover-"));
    const destination = join(root, "vendor");
    const backup = join(root, "vendor.backup-interrupted");
    await mkdir(backup);
    await writeFile(join(backup, "marker.txt"), "installed\n");

    await recoverInterruptedInstall(destination);

    assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "installed\n");
});
