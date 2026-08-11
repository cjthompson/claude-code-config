import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    EXPECTED_REFERENCE_FILES,
    PINNED_COMMIT,
    assertImmutableCommit,
    installSnapshot,
    recoverInterruptedInstall,
    sha256,
    validateReferenceInventory,
    verifySnapshot,
} from "../../../plugins/typescript-development/scripts/sync-typescript-references.mjs";


test("reference inventory is curated and rejects drift", () => {
    assert.ok(EXPECTED_REFERENCE_FILES.length >= 25);
    assert.doesNotThrow(() => validateReferenceInventory(EXPECTED_REFERENCE_FILES));
    assert.throws(
        () => validateReferenceInventory(EXPECTED_REFERENCE_FILES.slice(1)),
        /missing:/,
    );
    assert.throws(
        () => validateReferenceInventory([...EXPECTED_REFERENCE_FILES, "unexpected.md"]),
        /unexpected:/,
    );
});


test("reference refresh accepts only an immutable commit", () => {
    assert.match(PINNED_COMMIT, /^[0-9a-f]{40}$/);
    assert.equal(assertImmutableCommit(PINNED_COMMIT), PINNED_COMMIT);
    for (const ref of ["main", "v2", "latest", "c8170c3", "../escape"]) {
        assert.throws(() => assertImmutableCommit(ref), /40-character commit/);
    }
});


test("offline snapshot verification detects changed content", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "typescript-reference-check-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "typescript-website"));
    await writeFile(join(root, "typescript-website/example.md"), "original\n");
    await writeFile(join(root, "upstreams.json"), JSON.stringify({
        version: 1,
        sources: {
            "microsoft/TypeScript-Website": {
                ref: PINNED_COMMIT,
                commit: PINNED_COMMIT,
                license: "CC-BY-4.0",
            },
        },
        files: { "typescript-website/example.md": sha256("original\n") },
    }));

    await assert.doesNotReject(verifySnapshot(root, ["typescript-website/example.md"]));
    await writeFile(join(root, "typescript-website/example.md"), "changed\n");
    await assert.rejects(verifySnapshot(root, ["typescript-website/example.md"]), /hash mismatch/);
});


test("failed staged validation leaves installed snapshot untouched", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "typescript-reference-install-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const destination = join(root, "vendor");
    const staged = join(root, "staged");
    await mkdir(destination);
    await mkdir(staged);
    await writeFile(join(destination, "marker"), "installed");

    await assert.rejects(
        installSnapshot(staged, destination, async () => { throw new Error("invalid staged snapshot"); }),
        /invalid staged snapshot/,
    );
    assert.equal(await readFile(join(destination, "marker"), "utf8"), "installed");
});


test("successful replacement installs the candidate", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "typescript-reference-replace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const destination = join(root, "vendor");
    const staged = join(root, "staged");
    await mkdir(destination);
    await mkdir(staged);
    await writeFile(join(destination, "marker"), "old");
    await writeFile(join(staged, "marker"), "new");

    await installSnapshot(staged, destination, async () => {});
    assert.equal(await readFile(join(destination, "marker"), "utf8"), "new");
});


test("interrupted replacement restores the sole backup", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "typescript-reference-recover-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const destination = join(root, "vendor");
    const backup = `${destination}.backup-123`;
    await mkdir(destination);
    await writeFile(join(destination, "marker"), "installed");
    await rename(destination, backup);

    await recoverInterruptedInstall(destination);
    assert.equal(await readFile(join(destination, "marker"), "utf8"), "installed");
});
