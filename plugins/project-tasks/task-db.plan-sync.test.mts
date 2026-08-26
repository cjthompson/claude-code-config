/*  Run the tests:
 *    node --experimental-strip-types --test plugins/project-tasks/task-db.plan-sync.test.mts
 *
 *  Full project-tasks suite:
 *    node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts
 *
 *  The reconciliation loop, against the real binary and a real database:
 *  `plan propose` → `plan apply` / `plan discard`, `plan attach` / `plan detach`,
 *  and `plan update`.
 *
 *  What makes these tests worth their runtime is that almost none of them can be
 *  written against the parser. The property that justifies the whole staging
 *  design — that `plan apply` commits the bytes that were REVIEWED, not the
 *  bytes on disk at the moment it runs — only shows up when a file changes
 *  between two subprocess invocations, and the guard that enforces it only shows
 *  up when the staged row is corrupted behind the helper's back.
 *
 *  Every test gets its own PROJECT_TASKS_HOME under os.tmpdir(). Nothing here
 *  reads or writes ~/.claude/tasks.db.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, 'bin', 'task-db');
const DB_URL = pathToFileURL(join(HERE, 'lib', 'db.mjs')).href;
const PLAN_SYNC_URL = pathToFileURL(join(HERE, 'lib', 'plan-sync.mjs')).href;

const { sha256 } = (await import(DB_URL)) as { sha256: (text: string) => string };

type Result = { code: number; out: string; err: string };

/** A fresh, isolated PROJECT_TASKS_HOME. */
function newHome(): string {
    return mkdtempSync(join(tmpdir(), 'task-db-sync-'));
}

/** Invoke the real binary. */
function run(home: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}): Result {
    const r = spawnSync(process.execPath, [BIN, ...args], {
        env: { ...process.env, ...envOverrides, PROJECT_TASKS_HOME: home },
        encoding: 'utf-8',
    });
    return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** Hold a real BEGIN IMMEDIATE lock until the returned cleanup function runs. */
async function acquireImmediateLock(home: string): Promise<{ release: () => Promise<void> }> {
    const holder = spawn('sqlite3', ['-bail', join(home, 'tasks.db')], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let closed = false;
    let ready = false;
    const exited = new Promise<number>((resolve) => {
        holder.once('close', (code) => {
            closed = true;
            resolve(code ?? -1);
        });
    });
    const acquired = new Promise<void>((resolve, reject) => {
        holder.stdout.setEncoding('utf-8');
        holder.stderr.setEncoding('utf-8');
        holder.stdout.on('data', (chunk: string) => {
            if (!ready && chunk.includes('__task_db_lock_held__')) {
                ready = true;
                resolve();
            }
        });
        holder.stderr.on('data', (chunk: string) => { stderr += chunk; });
        holder.once('error', reject);
        holder.once('close', (code) => {
            if (!ready) {
                reject(new Error(
                    `lock holder exited before acquiring the lock (${code ?? -1}): ${stderr.trim()}`,
                ));
            }
        });
    });

    try {
        holder.stdin.write("BEGIN IMMEDIATE;\nSELECT '__task_db_lock_held__';\n");
        await acquired;
    } catch (error) {
        if (!closed) holder.kill();
        await exited;
        throw error;
    }

    let released = false;
    return {
        async release() {
            if (released) return;
            released = true;
            try {
                holder.stdin.write('ROLLBACK;\n.quit\n');
                holder.stdin.end();
                const code = await exited;
                if (code !== 0) {
                    throw new Error(`lock holder exited with ${code}: ${stderr.trim()}`);
                }
            } finally {
                if (!closed) {
                    holder.kill();
                    await exited;
                }
            }
        },
    };
}

/** Read-only query straight to sqlite3, bypassing the binary entirely. */
function query(home: string, text: string): string {
    const r = spawnSync('sqlite3', ['-readonly', join(home, 'tasks.db')], {
        input: text,
        encoding: 'utf-8',
    });
    return (r.stdout ?? '').trim();
}

/** Write directly to the database, with foreign keys enforced. */
function exec(home: string, text: string): Result {
    const r = spawnSync('sqlite3', ['-bail', join(home, 'tasks.db')], {
        input: `PRAGMA foreign_keys=ON;\n${text}\n`,
        encoding: 'utf-8',
    });
    return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** A home with an initialized, current-schema database. */
function initialized(): string {
    const home = newHome();
    run(home, ['db', 'init']);
    return home;
}

/** Insert a plan row directly, bypassing `plan create`. */
function seedPlan(home: string, project = 'testproj', seq = 1): number {
    exec(
        home,
        `INSERT INTO plans(project,seq,title,source,created)
         VALUES('${project}',${seq},'Seeded plan','inline','2026-08-11 09:00');`,
    );
    return Number(query(home, `SELECT id FROM plans WHERE project='${project}' AND seq=${seq};`));
}

// ── fixtures ──────────────────────────────────────────────────

const V1 = '# Auth rewrite\n\n## Step one\n\nAdd the middleware.\n';
const V2 = '# Auth rewrite\n\n## Step one\n\nAdd the middleware.\n\n## Step two\n\nMigrate sessions.\n';

/** A linked plan P001 whose file holds `body`. Returns the file path. */
function linkedPlan(home: string, body = V1, name = 'plan.md'): string {
    const file = join(home, name);
    writeFileSync(file, body);
    const r = run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Linked', '--path', file]);
    strictEqual(r.code, 0, r.err);
    return file;
}

/** The plan's exact stored body, straight out of sqlite3. */
function storedContent(home: string, seq = 1): string {
    const r = spawnSync('sqlite3', ['-readonly', join(home, 'tasks.db')], {
        input: `SELECT COALESCE(content,'') FROM plans WHERE seq=${seq};\n`,
        encoding: 'utf-8',
    });
    const out = r.stdout ?? '';
    return out.endsWith('\n') ? out.slice(0, -1) : out;
}

/** The three staging columns, as a compact string. Empty means "nothing staged". */
function staging(home: string, seq = 1): string {
    return query(
        home,
        `SELECT COALESCE(pending_hash,'')||'|'||COALESCE(pending_at,'') FROM plans WHERE seq=${seq};`,
    );
}

function notes(home: string, seq = 1): Array<Record<string, any>> {
    return JSON.parse(query(home, `SELECT COALESCE(notes,'[]') FROM plans WHERE seq=${seq};`));
}

/** Add a child task to a plan and return its display seq number. */
function addChild(home: string, planId: number, title: string, anchor: string, project = 'testproj'): number {
    const r = run(home, [
        'task', 'add', '--project', project, '--type', 'task', '--title', title,
        '--plan-id', String(planId), '--anchor', anchor,
    ]);
    strictEqual(r.code, 0, r.err);
    return Number(r.out.replace('#', ''));
}

// ── propose → apply: the happy path ───────────────────────────

describe('plan propose → plan apply', () => {
    it('stages the new body, exits 3, and leaves the applied content alone', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);

        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 3, `expected the "staged, awaiting review" code\n${r.err}`);
        match(r.out, /^--- a\/P001$/m);
        match(r.out, /^\+\+\+ b\/P001$/m);
        match(r.out, /^\+## Step two$/m);

        // Staged, not applied.
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(V2));
        strictEqual(storedContent(home), V1);
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), sha256(V1));
    });

    it('promotes the staged bytes into content/content_hash/synced_at and clears staging', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);

        const before = query(home, 'SELECT synced_at FROM plans WHERE seq=1;');
        const r = run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0, r.err);

        strictEqual(storedContent(home), V2);
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), sha256(V2));
        strictEqual(staging(home), '|');
        ok(query(home, 'SELECT synced_at FROM plans WHERE seq=1;') !== '', 'synced_at must be set');
        strictEqual(typeof before, 'string');
    });

    it('records one applied note carrying the hash it committed', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']);

        const applied = notes(home).filter((n) => n.kind === 'applied');
        strictEqual(applied.length, 1);
        strictEqual(applied[0].hash, sha256(V2));
    });

    /**
     * The reason the propose/apply split exists at all. Between the diff the
     * caller reviewed and the apply that commits it, the source file changes.
     * A one-command "sync" would commit the late edit; staging must not.
     */
    it('commits the reviewed bytes even when the source file changed after the diff', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        strictEqual(run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']).code, 3);

        writeFileSync(file, `${V2}\n## Sneaky late edit\n`);
        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);

        strictEqual(storedContent(home), V2);
        ok(!storedContent(home).includes('Sneaky'), 'the late edit must not have been committed');
    });

    /**
     * An emptied source is a real edit, not a missing one. It is also the case
     * that separates "nothing staged" from "an empty document is staged":
     * `readfile()` on a zero-length file does not produce the same value as no
     * staging at all, so the candidate has to be recognised by `pending_hash`
     * rather than by whether the content column looks empty.
     */
    it('handles a source file emptied to zero bytes', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, '');

        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 3, r.err);
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(''));
        match(r.out, /^-# Auth rewrite$/m);

        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(storedContent(home), '');
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), sha256(''));
        strictEqual(staging(home), '|');
    });

    it('is exit 0 with nothing staged when the file matches the applied content', () => {
        const home = initialized();
        linkedPlan(home);
        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0, r.err);
        strictEqual(staging(home), '|');
        match(r.out, /unchanged/);
    });

    it('clears a stale candidate when the source is edited back to the applied content', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        strictEqual(run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']).code, 3);
        notStrictEqual(staging(home), '|');

        writeFileSync(file, V1);
        strictEqual(run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(staging(home), '|', 'a candidate that no longer differs must not keep firing drift');
    });

    it('preserves exit 3 when the diff is redirected with --output-file', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        const target = join(home, 'out', 'd.patch');

        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1', '--output-file', target]);
        strictEqual(r.code, 3);
        ok(existsSync(target));
        match(readFileSync(target, 'utf-8'), /^\+## Step two$/m);
    });
});

// ── propose → discard ─────────────────────────────────────────

describe('plan discard', () => {
    it('clears staging and leaves the applied content untouched', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);

        const r = run(home, ['plan', 'discard', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0, r.err);
        strictEqual(staging(home), '|');
        strictEqual(storedContent(home), V1);
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), sha256(V1));
    });

    it('leaves apply with nothing to do afterwards', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        run(home, ['plan', 'discard', '--project', 'testproj', '--seq', '1']);

        const r = run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']);
        notStrictEqual(r.code, 0);
        match(r.err, /nothing staged/);
    });

    it('is idempotent — discarding twice is not an error', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        strictEqual(run(home, ['plan', 'discard', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(run(home, ['plan', 'discard', '--project', 'testproj', '--seq', '1']).code, 0);
    });

    it('writes no note — there is no note kind for a discard to forge', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        const before = notes(home).length;
        run(home, ['plan', 'discard', '--project', 'testproj', '--seq', '1']);
        strictEqual(notes(home).length, before);
    });
});

// ── plan apply: refusals ──────────────────────────────────────

describe('plan apply — refusals', () => {
    it('refuses a replacement candidate that arrives after the reviewed candidate was verified', async () => {
        const home = initialized();
        const planId = seedPlan(home);
        const applied = '# Applied\n';
        const reviewed = '# Reviewed\n';
        const replacement = '# Replacement\n';
        exec(
            home,
            `UPDATE plans
                SET content='${applied}', content_hash='${sha256(applied)}',
                    pending_content='${replacement}', pending_hash='${sha256(replacement)}'
              WHERE id=${planId};`,
        );

        const previousHome = process.env.PROJECT_TASKS_HOME;
        process.env.PROJECT_TASKS_HOME = home;
        try {
            const { applyVerifiedStaging } = await import(PLAN_SYNC_URL);
            strictEqual(typeof applyVerifiedStaging, 'function');
            throws(
                () => applyVerifiedStaging(planId, sha256(reviewed), reviewed, '2026-08-26 12:00'),
                /changed before it could be applied/,
            );
        } finally {
            if (previousHome === undefined) delete process.env.PROJECT_TASKS_HOME;
            else process.env.PROJECT_TASKS_HOME = previousHome;
        }

        strictEqual(storedContent(home), applied);
        strictEqual(query(home, 'SELECT pending_content FROM plans WHERE id=1;'), replacement.trim());
        strictEqual(notes(home).filter((note) => note.kind === 'applied').length, 0);
    });

    it('fails cleanly when nothing is staged, without touching the content', () => {
        const home = initialized();
        linkedPlan(home);

        const r = run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']);
        notStrictEqual(r.code, 0);
        match(r.err, /^ERROR: P001 has nothing staged to apply\./m);
        match(r.err, /plan propose/);
        ok(!/\n\s+at /.test(r.err), 'a refusal must not surface a stack trace');
        strictEqual(storedContent(home), V1);
        strictEqual(notes(home).filter((n) => n.kind === 'applied').length, 0);
    });

    /**
     * The single most important test in this file. `plan apply` re-hashes what
     * it is about to promote and compares against the hash recorded when the
     * candidate was staged. Without that check the staging columns are just a
     * slower way to write the same race the split was introduced to remove:
     * anything that can reach the database can substitute a document between
     * the review and the commit.
     */
    it('refuses to promote staged bytes whose hash no longer matches pending_hash', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        strictEqual(run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']).code, 3);

        const stagedHash = query(home, 'SELECT pending_hash FROM plans WHERE seq=1;');
        strictEqual(stagedHash, sha256(V2));

        // Substitute the reviewed document, leaving the reviewed hash in place.
        exec(home, "UPDATE plans SET pending_content='# Tampered\n' WHERE seq=1;");

        const r = run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']);
        notStrictEqual(r.code, 0, 'apply must refuse a candidate that is not what was reviewed');
        match(r.err, /does not match the hash recorded/);
        match(r.err, new RegExp(stagedHash));
        match(r.err, new RegExp(sha256('# Tampered\n')));

        // Nothing moved, and the evidence is still there to inspect.
        strictEqual(storedContent(home), V1);
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), sha256(V1));
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), stagedHash);
        strictEqual(notes(home).filter((n) => n.kind === 'applied').length, 0);
    });

    it('errors on a plan that does not exist rather than reporting nothing staged', () => {
        const home = initialized();
        const r = run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '7']);
        notStrictEqual(r.code, 0);
        match(r.err, /no plan P007/);
    });
});

// ── re-proposing over a staged candidate ──────────────────────

describe('plan propose — over an existing candidate', () => {
    /**
     * Replacement rather than refusal. `propose` is the command whose job is to
     * stage the current state of the source, so refusing would strand a caller
     * who edited the file again mid-review with no way forward but `discard`.
     * It is safe because the diff and the staged bytes are written by the same
     * command: whatever ends up staged is exactly what was just printed.
     */
    it('replaces the staged candidate and diffs against the applied content, not the old candidate', () => {
        const home = initialized();
        const file = linkedPlan(home);

        writeFileSync(file, V2);
        strictEqual(run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']).code, 3);
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(V2));

        const v3 = `${V2}\n## Step three\n\nShip it.\n`;
        writeFileSync(file, v3);
        const second = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);

        strictEqual(second.code, 3);
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(v3));
        match(second.err, /already had a candidate staged/);
        // Both new sections appear, because the baseline is the applied body.
        match(second.out, /^\+## Step two$/m);
        match(second.out, /^\+## Step three$/m);
    });

    it('applies the most recent candidate, not the first one', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        const v3 = `${V2}\n## Step three\n\nShip it.\n`;
        writeFileSync(file, v3);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);

        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(storedContent(home), v3);
    });
});

// ── source-type guards and unreadable sources ─────────────────

describe('plan propose — source guards', () => {
    it('refuses a bare propose on an inline plan and names the way out', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);

        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 1);
        match(r.err, /P001 is inline — no source file to re-read/);
        match(r.err, /--content-file/);
        strictEqual(staging(home), '|');
    });

    it('refuses --content-file on a linked plan and names the linked path', () => {
        const home = initialized();
        const file = linkedPlan(home);
        const other = join(home, 'other.md');
        writeFileSync(other, V2);

        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1', '--content-file', other]);
        strictEqual(r.code, 1);
        match(r.err, new RegExp(`P001 is linked to ${file}`));
        match(r.err, /plan attach/);
        strictEqual(staging(home), '|', 'a rejected propose must not stage anything');
    });

    it('exits 4 when the linked file has been deleted, without crashing', () => {
        const home = initialized();
        const file = linkedPlan(home);
        rmSync(file);

        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 4, 'an unreadable source is 4, distinct from 3 and from a plain error');
        match(r.err, new RegExp(`cannot read '${file}'`));
        ok(!/\n\s+at /.test(r.err), 'a missing file must not surface a stack trace');
        strictEqual(staging(home), '|');
        strictEqual(storedContent(home), V1, 'the applied body survives a missing source');
    });

    it('exits 4 when an inline plan is given a --content-file that does not exist', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);
        const r = run(home, [
            'plan', 'propose', '--project', 'testproj', '--seq', '1',
            '--content-file', join(home, 'nope.md'),
        ]);
        strictEqual(r.code, 4);
        match(r.err, /cannot read/);
    });

    it('stages and applies a supplied body for an inline plan', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);
        const body = join(home, 'body.md');
        writeFileSync(body, V1);

        strictEqual(
            run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1', '--content-file', body]).code,
            3,
        );
        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(storedContent(home), V1);
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'inline');
    });
});

// ── the duplicate-anchor guard ────────────────────────────────

describe('plan propose — duplicate anchors', () => {
    it('refuses a body whose duplicate heading slug is an existing task anchor, and stages nothing', () => {
        const home = initialized();
        const file = linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        addChild(home, planId, 'Add the middleware', 'Step one');

        writeFileSync(file, '# Auth rewrite\n\n## Step one\n\nA.\n\n## Step  ONE!\n\nB.\n');
        const r = run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);

        notStrictEqual(r.code, 0);
        match(r.err, /same anchor/);
        match(r.err, /step-one/);
        match(r.err, /#001/);
        strictEqual(staging(home), '|', 'an ambiguous body must not be staged');
    });

    it('allows duplicate headings that no task has claimed', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, '# Auth rewrite\n\n## Notes\n\nA.\n\n## Notes\n\nB.\n');
        strictEqual(run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']).code, 3);
    });
});

// ── attach / detach ───────────────────────────────────────────

describe('plan attach', () => {
    it('links an inline plan and stages the file for review', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);
        const file = join(home, 'doc.md');
        writeFileSync(file, V1);

        const r = run(home, ['plan', 'attach', '--project', 'testproj', '--seq', '1', '--path', file]);
        strictEqual(r.code, 0, r.err);
        strictEqual(query(home, "SELECT source||'|'||path FROM plans WHERE seq=1;"), `linked|${file}`);
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(V1));
        strictEqual(storedContent(home), '', 'attach stages; it does not apply');

        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(storedContent(home), V1);
    });

    it('changes the path of an already-linked plan and stages the new file', () => {
        const home = initialized();
        const first = linkedPlan(home);
        const second = join(home, 'second.md');
        writeFileSync(second, V2);

        const r = run(home, ['plan', 'attach', '--project', 'testproj', '--seq', '1', '--path', second]);
        strictEqual(r.code, 0, r.err);
        strictEqual(query(home, 'SELECT path FROM plans WHERE seq=1;'), second);
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'linked');
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(V2));

        // The old file is irrelevant from here on: a propose re-reads the new path.
        writeFileSync(first, '# Ignored\n');
        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(storedContent(home), V2);
    });

    it('refuses while a different candidate is staged', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);

        const other = join(home, 'other.md');
        writeFileSync(other, '# Different\n');
        const r = run(home, ['plan', 'attach', '--project', 'testproj', '--seq', '1', '--path', other]);

        notStrictEqual(r.code, 0);
        match(r.err, /different candidate staged/);
        strictEqual(query(home, 'SELECT path FROM plans WHERE seq=1;'), file, 'the link must not have moved');
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(V2));
    });

    it('stages nothing when the attached file already matches the applied content', () => {
        const home = initialized();
        const file = linkedPlan(home);
        const copy = join(home, 'copy.md');
        writeFileSync(copy, V1);

        const r = run(home, ['plan', 'attach', '--project', 'testproj', '--seq', '1', '--path', copy]);
        strictEqual(r.code, 0, r.err);
        strictEqual(staging(home), '|');
        strictEqual(query(home, 'SELECT path FROM plans WHERE seq=1;'), copy);
        strictEqual(storedContent(home), V1);
        strictEqual(typeof file, 'string');
    });

    it('errors on an unreadable path without changing the link', () => {
        const home = initialized();
        const file = linkedPlan(home);
        const r = run(home, [
            'plan', 'attach', '--project', 'testproj', '--seq', '1', '--path', join(home, 'nope.md'),
        ]);
        notStrictEqual(r.code, 0);
        match(r.err, /cannot read/);
        strictEqual(query(home, 'SELECT path FROM plans WHERE seq=1;'), file);
    });
});

describe('plan detach', () => {
    it('does not unlink a source that changed after detach first inspected it', async () => {
        const home = initialized();
        const file = join(home, 'source.md');
        const checked = '# Applied\n';
        const lateEdit = '# Late edit\n';
        writeFileSync(file, checked);

        // This is the state a detach has already verified before it commits the
        // database transition. A save while that transition waits for SQLite
        // must keep the changed source on disk.
        writeFileSync(file, lateEdit);
        const { unlinkVerifiedSource } = await import(PLAN_SYNC_URL);
        strictEqual(typeof unlinkVerifiedSource, 'function');
        throws(() => unlinkVerifiedSource(file, checked), /changed after it was checked/);
        strictEqual(readFileSync(file, 'utf-8'), lateEdit);
    });

    it('returns a matching plan to inline, preserving the body and recording origin_path', () => {
        const home = initialized();
        const file = linkedPlan(home);

        const r = run(home, ['plan', 'detach', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0, r.err);
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'inline');
        strictEqual(query(home, 'SELECT path FROM plans WHERE seq=1;'), '', 'inline plans must have no path');
        strictEqual(query(home, 'SELECT origin_path FROM plans WHERE seq=1;'), file);
        strictEqual(storedContent(home), V1, 'the body survives the detach');
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), sha256(V1));
        ok(existsSync(file), 'detach without --delete-file leaves the file alone');
    });

    it('--delete-file unlinks a matching source after the row is inline', () => {
        const home = initialized();
        const file = linkedPlan(home);
        const r = run(home, ['plan', 'detach', '--project', 'testproj', '--seq', '1', '--delete-file']);
        strictEqual(r.code, 0, r.err);
        ok(!existsSync(file));
        strictEqual(storedContent(home), V1, 'the only copy of the plan is now the database');
    });

    it('requires --confirm-source-change when the live file differs', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);

        const r = run(home, ['plan', 'detach', '--project', 'testproj', '--seq', '1']);
        notStrictEqual(r.code, 0);
        match(r.err, /--confirm-source-change/);
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'linked', 'nothing may move');
        strictEqual(staging(home), '|');
    });

    it('with confirmation, preserves the changed bytes as a pending candidate', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);

        const r = run(home, [
            'plan', 'detach', '--project', 'testproj', '--seq', '1', '--confirm-source-change',
        ]);
        strictEqual(r.code, 0, r.err);
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'inline');
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), sha256(V2));
        strictEqual(storedContent(home), V1, 'the applied body is untouched until reconciliation');
        ok(existsSync(file), 'a changed source file stays on disk');

        // The retained bytes are reconcilable exactly like any other candidate.
        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(storedContent(home), V2);
    });

    it('refuses --delete-file while the source holds unreconciled changes', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);

        const r = run(home, [
            'plan', 'detach', '--project', 'testproj', '--seq', '1',
            '--confirm-source-change', '--delete-file',
        ]);
        notStrictEqual(r.code, 0);
        match(r.err, /refusing to delete/);
        ok(existsSync(file));
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'linked', 'the refusal is total');
    });

    it('detaches a plan whose linked file has vanished, warning rather than crashing', () => {
        const home = initialized();
        const file = linkedPlan(home);
        rmSync(file);

        const r = run(home, ['plan', 'detach', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0, r.err);
        match(r.err, /no longer exists/);
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'inline');
        strictEqual(query(home, 'SELECT origin_path FROM plans WHERE seq=1;'), file);
        strictEqual(storedContent(home), V1);
    });

    it('refuses on a plan that is already inline', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);
        const r = run(home, ['plan', 'detach', '--project', 'testproj', '--seq', '1']);
        notStrictEqual(r.code, 0);
        match(r.err, /already inline/);
    });

    it('round-trips: attach then detach leaves the body intact and the plan inline', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);
        const file = join(home, 'doc.md');
        writeFileSync(file, V2);

        run(home, ['plan', 'attach', '--project', 'testproj', '--seq', '1', '--path', file]);
        run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']);
        run(home, ['plan', 'detach', '--project', 'testproj', '--seq', '1']);

        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'inline');
        strictEqual(storedContent(home), V2);
        strictEqual(staging(home), '|');
    });
});

// ── plan update ───────────────────────────────────────────────

describe('plan update — metadata', () => {
    it('changes title and tags without touching the body', () => {
        const home = initialized();
        linkedPlan(home);
        const r = run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--title', 'Renamed', '--tag', 'release', '--tag', 'auth',
        ]);
        strictEqual(r.code, 0, r.err);
        strictEqual(query(home, 'SELECT title FROM plans WHERE seq=1;'), 'Renamed');
        strictEqual(query(home, 'SELECT tags FROM plans WHERE seq=1;'), '["release","auth"]');
        strictEqual(storedContent(home), V1);
    });

    it('writes no lifecycle note when no status changed', () => {
        const home = initialized();
        linkedPlan(home);
        const before = notes(home).length;
        run(home, ['plan', 'update', '--project', 'testproj', '--seq', '1', '--title', 'Renamed']);
        strictEqual(notes(home).length, before);
    });

    it('records a status note for an ordinary transition', () => {
        const home = initialized();
        linkedPlan(home);
        run(home, ['plan', 'update', '--project', 'testproj', '--seq', '1', '--status', 'in_progress']);
        const status = notes(home).filter((n) => n.kind === 'status');
        strictEqual(status.length, 1);
        match(status[0].note, /pending → in_progress/);
    });
});

describe('plan update — cancelling', () => {
    function planWithChildren(home: string) {
        const file = linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        const one = addChild(home, planId, 'Step one', 'step-one');
        const two = addChild(home, planId, 'Step two', 'step-two');
        const three = addChild(home, planId, 'Step three', 'step-three');
        run(home, ['task', 'update', '--project', 'testproj', '--seq', String(one), '--status', 'completed']);
        run(home, ['task', 'update', '--project', 'testproj', '--seq', String(two), '--status', 'in_progress']);
        return { planId, one, two, three, file };
    }

    it('refuses without --confirm-cancel and reports the children at stake', () => {
        const home = initialized();
        const { one, two } = planWithChildren(home);

        // Read the status rather than assuming `pending`: the fixture starts a
        // child, and `task update` promotes a plan on its first child moving to
        // `in_progress`. The claim under test is that the REFUSAL changes
        // nothing, so compare against whatever the fixture legitimately left.
        const before = query(home, 'SELECT status FROM plans WHERE seq=1;');
        strictEqual(before, 'in_progress', 'the fixture should have auto-advanced the plan');

        const r = run(home, ['plan', 'update', '--project', 'testproj', '--seq', '1', '--status', 'cancelled']);
        notStrictEqual(r.code, 0);
        match(r.err, /needs confirmation/);
        match(r.err, /--confirm-cancel/);
        match(r.err, /in progress/);
        match(r.err, new RegExp(`#${String(two).padStart(3, '0')}`));
        match(r.err, new RegExp(`#${String(one).padStart(3, '0')}`));

        strictEqual(query(home, 'SELECT status FROM plans WHERE seq=1;'), before, 'a refusal writes nothing');
        strictEqual(query(home, "SELECT count(*) FROM tasks WHERE status='cancelled';"), '0');
    });

    it('requires the flag even when the plan has no children at all', () => {
        const home = initialized();
        linkedPlan(home);
        const r = run(home, ['plan', 'update', '--project', 'testproj', '--seq', '1', '--status', 'cancelled']);
        notStrictEqual(r.code, 0);
        match(r.err, /--confirm-cancel/);
        strictEqual(query(home, 'SELECT status FROM plans WHERE seq=1;'), 'pending');
    });

    /**
     * `tasks.plan_id` is ON DELETE RESTRICT precisely so a plan with children
     * cannot vanish from under them. Cancelling must therefore mark them, not
     * remove them, and must not sever the link that makes the history legible.
     */
    it('cascades to non-completed children, keeps them, and preserves plan_id', () => {
        const home = initialized();
        const { planId, one, two, three } = planWithChildren(home);

        const r = run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'cancelled', '--confirm-cancel',
        ]);
        strictEqual(r.code, 0, r.err);

        strictEqual(query(home, 'SELECT status FROM plans WHERE seq=1;'), 'cancelled');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${one};`), 'completed');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${two};`), 'cancelled');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${three};`), 'cancelled');

        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), '3', 'nothing may be deleted');
        strictEqual(
            query(home, `SELECT count(*) FROM tasks WHERE plan_id=${planId};`),
            '3',
            'no child may be orphaned',
        );
    });

    it('records one status note naming the cascade and the tasks it cancelled', () => {
        const home = initialized();
        const { two, three } = planWithChildren(home);
        run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'cancelled', '--confirm-cancel',
        ]);

        const status = notes(home).filter((n) => n.kind === 'status');
        strictEqual(status.length, 1);
        match(status[0].note, /Cancelled 2 child task\(s\)/);
        match(status[0].note, /1 completed child task\(s\) left untouched/);
        deepStrictEqual(status[0].tasks, [
            { project: 'testproj', seq: two },
            { project: 'testproj', seq: three },
        ]);
    });

    /**
     * `--project` identifies the plan's OWNER and never filters its children —
     * a plan is global and may describe coordinated work in several
     * repositories. A cascade that scoped itself to the plan's own project
     * would leave the other repository's tasks pointing at a cancelled plan.
     */
    it('cascades to children in other projects, not just the plan owner’s', () => {
        const home = initialized();
        linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        addChild(home, planId, 'Backend step', 'backend-step');
        addChild(home, planId, 'Frontend step', 'frontend-step', 'frontend');

        run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'cancelled', '--confirm-cancel',
        ]);
        strictEqual(query(home, "SELECT status FROM tasks WHERE project='frontend';"), 'cancelled');
        strictEqual(query(home, "SELECT status FROM tasks WHERE project='testproj';"), 'cancelled');
        const status = notes(home).find((n) => n.kind === 'status');
        deepStrictEqual(status.tasks, [
            { project: 'frontend', seq: 1 },
            { project: 'testproj', seq: 1 },
        ]);
    });

    it('leaves an already-cancelled child untouched rather than restamping it', () => {
        const home = initialized();
        const file = linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        const one = addChild(home, planId, 'Step one', 'step-one');
        exec(home, `UPDATE tasks SET status='cancelled', updated='2020-01-01 00:00' WHERE seq=${one};`);

        run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'cancelled', '--confirm-cancel',
        ]);
        strictEqual(query(home, `SELECT updated FROM tasks WHERE seq=${one};`), '2020-01-01 00:00');
        strictEqual(typeof file, 'string');
    });

    it('rolls the whole cancellation back when the lock timeout expires', async () => {
        const home = initialized();
        const { planId } = planWithChildren(home);
        const planBefore = {
            status: query(home, 'SELECT status FROM plans WHERE seq=1;'),
            updated: query(home, 'SELECT updated FROM plans WHERE seq=1;'),
            notes: query(home, 'SELECT COALESCE(notes,\'\') FROM plans WHERE seq=1;'),
        };
        const childrenBefore = query(
            home,
            `SELECT seq || '|' || status || '|' || updated || '|' ||
                    COALESCE(completed_at,'') || '|' || plan_id
             FROM tasks WHERE plan_id=${planId} ORDER BY seq;`,
        );
        const notesBefore = notes(home);
        const lock = await acquireImmediateLock(home);

        try {
            const started = Date.now();
            const r = run(
                home,
                [
                    'plan', 'update', '--project', 'testproj', '--seq', '1',
                    '--status', 'cancelled', '--confirm-cancel',
                ],
                { PROJECT_TASKS_BUSY_TIMEOUT_MS: '200' },
            );
            const elapsed = Date.now() - started;

            ok(elapsed >= 150, `the write returned in ${elapsed}ms — too soon for a 200ms timeout`);
            notStrictEqual(r.code, 0);
            match(r.err, /database stayed locked for longer than 200ms/);
            match(r.err, /transaction was rolled back/);
        } finally {
            await lock.release();
        }

        deepStrictEqual(
            {
                status: query(home, 'SELECT status FROM plans WHERE seq=1;'),
                updated: query(home, 'SELECT updated FROM plans WHERE seq=1;'),
                notes: query(home, 'SELECT COALESCE(notes,\'\') FROM plans WHERE seq=1;'),
            },
            planBefore,
        );
        strictEqual(query(home, `SELECT count(*) FROM plans WHERE id=${planId};`), '1');
        strictEqual(
            query(
                home,
                `SELECT seq || '|' || status || '|' || updated || '|' ||
                        COALESCE(completed_at,'') || '|' || plan_id
                 FROM tasks WHERE plan_id=${planId} ORDER BY seq;`,
            ),
            childrenBefore,
        );
        strictEqual(query(home, `SELECT count(*) FROM tasks WHERE plan_id=${planId};`), '3');
        deepStrictEqual(notes(home), notesBefore);
        strictEqual(notes(home).filter((note) => note.kind === 'status').length, 0);
    });
});

describe('plan update — completing', () => {
    it('refuses non-terminal children without --force-complete and lists them', () => {
        const home = initialized();
        linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        const open = addChild(home, planId, 'Unfinished', 'unfinished');

        const r = run(home, ['plan', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed']);
        notStrictEqual(r.code, 0);
        match(r.err, /--force-complete/);
        match(r.err, new RegExp(`#${String(open).padStart(3, '0')}`));
        strictEqual(query(home, 'SELECT status FROM plans WHERE seq=1;'), 'pending');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${open};`), 'pending');
    });

    it('--force-complete closes the open children with a completion timestamp', () => {
        const home = initialized();
        linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        const one = addChild(home, planId, 'Pending step', 'pending-step');
        const two = addChild(home, planId, 'Running step', 'running-step');
        run(home, ['task', 'update', '--project', 'testproj', '--seq', String(two), '--status', 'in_progress']);

        const r = run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'completed', '--force-complete',
        ]);
        strictEqual(r.code, 0, r.err);
        strictEqual(query(home, 'SELECT status FROM plans WHERE seq=1;'), 'completed');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${one};`), 'completed');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${two};`), 'completed');
        notStrictEqual(query(home, `SELECT completed_at FROM tasks WHERE seq=${one};`), '');

        const status = notes(home).filter((n) => n.kind === 'status');
        strictEqual(status.length, 1, 'one lifecycle note for the whole batch');
        match(status[0].note, /Force-completed 2 child task\(s\)/);
        deepStrictEqual(status[0].tasks, [
            { project: 'testproj', seq: one },
            { project: 'testproj', seq: two },
        ]);
    });

    it('force-completion records qualified refs when project sequences collide', () => {
        const home = initialized();
        linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        addChild(home, planId, 'Backend step', 'backend-step', 'testproj');
        addChild(home, planId, 'Frontend step', 'frontend-step', 'frontend');

        const r = run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'completed', '--force-complete',
        ]);
        strictEqual(r.code, 0, r.err);
        const status = notes(home).find((n) => n.kind === 'status');
        deepStrictEqual(status.tasks, [
            { project: 'frontend', seq: 1 },
            { project: 'testproj', seq: 1 },
        ]);
    });

    it('does not rewrite a completion timestamp a task already had', () => {
        const home = initialized();
        linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        const one = addChild(home, planId, 'Started early', 'started-early');
        exec(home, `UPDATE tasks SET completed_at='2020-01-01 00:00' WHERE seq=${one};`);

        run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'completed', '--force-complete',
        ]);
        strictEqual(query(home, `SELECT completed_at FROM tasks WHERE seq=${one};`), '2020-01-01 00:00');
    });

    it('closes directly when every child is terminal, cancelled included', () => {
        const home = initialized();
        linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        const one = addChild(home, planId, 'Done', 'done');
        const two = addChild(home, planId, 'Dropped', 'dropped');
        run(home, ['task', 'update', '--project', 'testproj', '--seq', String(one), '--status', 'completed']);
        run(home, ['task', 'update', '--project', 'testproj', '--seq', String(two), '--status', 'cancelled']);

        const r = run(home, ['plan', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed']);
        strictEqual(r.code, 0, r.err);
        strictEqual(query(home, 'SELECT status FROM plans WHERE seq=1;'), 'completed');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${two};`), 'cancelled');
    });
});

// ── staging is visible to the read side ───────────────────────

/**
 * `references/plans.md` defines a non-empty drift indicator as "a candidate is
 * staged OR the linked file no longer matches the applied hash", and `plan
 * list` is where a caller sees it. These are the cheapest end-to-end proof that
 * what `propose` writes is observable outside the reconciliation loop: a plan
 * with a candidate awaiting review must never look idle.
 *
 * NOTE: both tests require `planDrift`'s `'staged'` return value, added in
 * `70d996d` on `project-tasks-plans`. This branch is based on `ad71626` and
 * does not carry that commit, so both fail here and pass once the two are
 * merged. They are written against the corrected contract deliberately rather
 * than against the behavior this worktree happens to have.
 */
describe('drift reflects a staged candidate', () => {
    /** The trailing drift field of `plan list` for P00`seq`. */
    function drift(home: string, seq = 1): string {
        const line = run(home, ['plan', 'list', '--project', 'testproj']).out
            .split('\n')
            .find((row) => row.startsWith(`P${String(seq).padStart(3, '0')}|`));
        ok(line, 'plan list printed no row for the plan');
        return line.split('|').pop() as string;
    }

    it('a linked plan reads drifted, then staged, then clean across propose and apply', () => {
        const home = initialized();
        const file = linkedPlan(home);
        strictEqual(drift(home), 'clean');

        writeFileSync(file, V2);
        strictEqual(drift(home), 'drifted');

        strictEqual(run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']).code, 3);
        strictEqual(drift(home), 'staged', 'a staged candidate outranks the file comparison');

        strictEqual(run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(drift(home), 'clean', 'applying resolves both the candidate and the file');
    });

    /**
     * The case the file-only comparison could never see: an inline plan has no
     * external file, so its drift is `n/a` — but a candidate awaiting review is
     * exactly as actionable as a changed file, and reporting `n/a` for it hides
     * a pending decision.
     */
    it('an inline plan reads n/a, then staged, then n/a across propose and discard', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);
        strictEqual(drift(home), 'n/a');

        const body = join(home, 'body.md');
        writeFileSync(body, V1);
        strictEqual(
            run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1', '--content-file', body]).code,
            3,
        );
        strictEqual(drift(home), 'staged');

        strictEqual(run(home, ['plan', 'discard', '--project', 'testproj', '--seq', '1']).code, 0);
        strictEqual(drift(home), 'n/a');
    });
});

// ── atomicity ─────────────────────────────────────────────────

describe('transaction atomicity', () => {
    /**
     * A cancel is three writes — the plan row, the child cascade, the lifecycle
     * note — and the first of them has already run when the second fails. A
     * trigger that aborts any UPDATE on `tasks` forces exactly that, and the
     * observable outcome must be that none of the three survived.
     */
    it('rolls the whole cancel back when the child cascade fails mid-batch', () => {
        const home = initialized();
        linkedPlan(home);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        const one = addChild(home, planId, 'Step one', 'step-one');
        const notesBefore = notes(home).length;

        exec(home, "CREATE TRIGGER boom BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'boom'); END;");
        const r = run(home, [
            'plan', 'update', '--project', 'testproj', '--seq', '1',
            '--status', 'cancelled', '--confirm-cancel',
        ]);
        exec(home, 'DROP TRIGGER boom;');

        notStrictEqual(r.code, 0);
        match(r.err, /rolled back/);
        strictEqual(query(home, 'SELECT status FROM plans WHERE seq=1;'), 'pending', 'the plan row must not stick');
        strictEqual(query(home, `SELECT status FROM tasks WHERE seq=${one};`), 'pending');
        strictEqual(notes(home).length, notesBefore, 'no lifecycle note may survive a rolled-back cascade');
    });

    it('rolls the whole apply back when the applied note fails', () => {
        const home = initialized();
        const file = linkedPlan(home);
        writeFileSync(file, V2);
        run(home, ['plan', 'propose', '--project', 'testproj', '--seq', '1']);
        const stagedHash = query(home, 'SELECT pending_hash FROM plans WHERE seq=1;');

        // The note is appended by a second UPDATE on `plans`, after the promotion.
        exec(
            home,
            `CREATE TRIGGER boom AFTER UPDATE OF notes ON plans BEGIN SELECT RAISE(ABORT,'boom'); END;`,
        );
        const r = run(home, ['plan', 'apply', '--project', 'testproj', '--seq', '1']);
        exec(home, 'DROP TRIGGER boom;');

        notStrictEqual(r.code, 0);
        strictEqual(storedContent(home), V1, 'the promotion must not survive its note failing');
        strictEqual(query(home, 'SELECT pending_hash FROM plans WHERE seq=1;'), stagedHash);
    });
});
