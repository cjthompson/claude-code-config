/*  Run the tests:
 *    node --experimental-strip-types --test plugins/project-tasks/task-db.integration.test.mts
 *
 *  These are the tests `task-db.test.mts` deliberately cannot be: they spawn the
 *  real binary against a real sqlite3 and a real temp database. The parser suite
 *  proves argv shape; this one proves the things only a live database can show —
 *  that the migration is additive, that the foreign key is a constraint rather
 *  than a comment, that a failed batch leaves nothing behind, and that two
 *  writers racing on the same plan cannot allocate the same note id.
 *
 *  Every test gets its own PROJECT_TASKS_HOME. Nothing here reads or writes
 *  ~/.claude/tasks.db.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, RENAMES } from './lib/registry.mjs';
import { HANDLERS } from './lib/handlers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, 'bin', 'task-db');
const DB_URL = pathToFileURL(join(HERE, 'lib', 'db.mjs')).href;

type Result = { code: number; out: string; err: string };

/** A fresh, isolated PROJECT_TASKS_HOME. */
function newHome(): string {
    return mkdtempSync(join(tmpdir(), 'task-db-it-'));
}

/** Invoke the real binary. */
function run(home: string, args: string[]): Result {
    const r = spawnSync(process.execPath, [BIN, ...args], {
        env: { ...process.env, PROJECT_TASKS_HOME: home },
        encoding: 'utf-8',
    });
    return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
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

/** A plausible value for one declared option type. */
function valueFor(opt: any): string {
    const type = String(opt.type).replace(/\[\]$/, '');
    switch (type) {
        case 'int': return '1';
        case 'taskref': return 'testproj#1';
        case 'enum': return opt.values[0];
        case 'ts': return '2026-08-09 12:00';
        case 'sha': return 'deadbeef';
        case 'abspath':
        case 'path': return '/tmp/task-db-it.md';
        default: return 'x';
    }
}

/**
 * The minimum argv that satisfies a command's own spec.
 *
 * Built from `COMMANDS` rather than hand-written so a plan command that gains a
 * required flag later still reaches its handler here, instead of turning this
 * suite's "routes, then refuses" assertion into a parse error that happens to
 * also be non-zero.
 */
function canonicalArgv(command: string): string[] {
    const spec = (COMMANDS as any)[command];
    const args = command.split(' ');
    if (spec.project) args.push('--project', 'p');
    for (const [flag, opt] of Object.entries<any>(spec.opts)) {
        if (!opt.required) continue;
        if (opt.type === 'bool') args.push(flag);
        else args.push(flag, valueFor(opt));
    }
    // `atLeastOne` is a cross-flag rule rather than a per-flag `required`, so a
    // spec-derived argv that ignores it parses as a no-op mutation error.
    for (const set of spec.rules?.atLeastOne ?? []) {
        if (set.flags.some((flag: string) => args.includes(flag))) continue;
        const flag = set.flags[0];
        const opt = spec.opts[flag];
        if (opt.type === 'bool') args.push(flag);
        else args.push(flag, valueFor(opt));
    }
    return args;
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

// ── db init: the schema, created from nothing ─────────────────

describe('db init — fresh database', () => {
    const home = newHome();

    it('exits 2 on first-time setup and 0 thereafter', () => {
        strictEqual(run(home, ['db', 'init']).code, 2);
        strictEqual(run(home, ['db', 'init']).code, 0);
        strictEqual(run(home, ['db', 'init']).code, 0);
    });

    it('creates the plans table with every specified column', () => {
        const columns = query(home, 'PRAGMA table_info(plans);')
            .split('\n')
            .map((line) => line.split('|')[1]);
        deepStrictEqual(columns, [
            'id', 'project', 'seq', 'title', 'source', 'path', 'origin_path',
            'content', 'content_hash', 'synced_at', 'pending_content',
            'pending_hash', 'pending_at', 'status', 'notes', 'tags',
            'created', 'updated',
        ]);
    });

    it('constrains plans.source and plans.status, and makes (project,seq) unique', () => {
        const ddl = query(home, "SELECT sql FROM sqlite_master WHERE name='plans';");
        match(ddl, /CHECK\(source IN\('inline','linked'\)\)/);
        match(ddl, /CHECK\(status IN\('pending','in_progress','completed','cancelled'\)\)/);
        match(ddl, /UNIQUE\(project,seq\)/);
    });

    it('adds plan_id, plan_anchor and commit_sha to tasks', () => {
        const columns = query(home, 'PRAGMA table_info(tasks);')
            .split('\n')
            .map((line) => line.split('|')[1]);
        for (const column of ['plan_id', 'plan_anchor', 'commit_sha', 'feedback', 'completed_at']) {
            ok(columns.includes(column), `tasks is missing ${column}`);
        }
    });

    it('declares plan_id as ON DELETE RESTRICT against plans(id)', () => {
        // id|seq|table|from|to|on_update|on_delete|match
        const fks = query(home, 'PRAGMA foreign_key_list(tasks);');
        match(fks, /\|plans\|plan_id\|id\|NO ACTION\|RESTRICT\|/);
    });

    it('creates the anchor index as PARTIAL, so plan-less rows stay out of it', () => {
        const ddl = query(
            home,
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tasks_plan_anchor';",
        );
        match(ddl, /UNIQUE INDEX/);
        match(ddl, /tasks\(plan_id, plan_anchor\)/);
        match(ddl, /WHERE plan_anchor IS NOT NULL/);
    });
});

// ── db init: the additive migration ───────────────────────────

/**
 * The pre-Wave-1 schema, verbatim: no `feedback`, no `completed_at`, and none of
 * the plan columns. This is what the 350 rows in the live database were written
 * against, and the only honest way to test the migration is to migrate one.
 */
const OLD_SCHEMA = `CREATE TABLE tasks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN('fix','task','todo')),
    title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN('high','medium','low')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','completed','cancelled')),
    tags TEXT DEFAULT '[]',
    reqs TEXT DEFAULT '[]',
    depends_on TEXT DEFAULT '[]',
    created TEXT NOT NULL,
    updated TEXT,
    in_changelog INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project,seq)
);`;

describe('db init — additive migration against an old-schema database', () => {
    const home = newHome();
    const projects = ['github.com/o/alpha', 'github.com/o/beta', 'local/gamma'];
    const seeded: string[] = [];

    // Seed rows across several projects, with overlapping per-project sequences —
    // the shape a renumbering bug would scramble.
    const inserts: string[] = [];
    let id = 0;
    for (const project of projects) {
        for (let seq = 1; seq <= 7; seq++) {
            id++;
            const title = `Row ${id} for ${project}`;
            inserts.push(
                `INSERT INTO tasks(id,project,seq,type,title,priority,status,created,in_changelog)
                 VALUES(${id},'${project}',${seq},'task','${title}','medium','pending','2026-01-0${(seq % 9) + 1} 08:00',0);`,
            );
            seeded.push(`${id}|${project}|${seq}|${title}`);
        }
    }
    exec(home, `${OLD_SCHEMA}\n${inserts.join('\n')}`);

    const before = query(home, 'SELECT id||"|"||project||"|"||seq||"|"||title FROM tasks ORDER BY id;');
    const beforeCount = query(home, 'SELECT count(*) FROM tasks;');
    const beforeSeqTable = query(home, "SELECT seq FROM sqlite_sequence WHERE name='tasks';");

    it('starts from a genuine old-schema database', () => {
        strictEqual(beforeCount, '21');
        const columns = query(home, 'PRAGMA table_info(tasks);').split('\n').map((l) => l.split('|')[1]);
        ok(!columns.includes('feedback'));
        ok(!columns.includes('completed_at'));
        ok(!columns.includes('plan_id'));
    });

    it('reports the database as pre-existing (exit 0, not 2)', () => {
        strictEqual(run(home, ['db', 'init']).code, 0);
    });

    it('loses no rows and renumbers nothing', () => {
        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), beforeCount);
        strictEqual(
            query(home, 'SELECT id||"|"||project||"|"||seq||"|"||title FROM tasks ORDER BY id;'),
            before,
        );
        deepStrictEqual(before.split('\n'), seeded);
    });

    it('leaves the AUTOINCREMENT counter alone', () => {
        strictEqual(query(home, "SELECT seq FROM sqlite_sequence WHERE name='tasks';"), beforeSeqTable);
    });

    it('adds every new column as NULL on every existing row', () => {
        const columns = query(home, 'PRAGMA table_info(tasks);').split('\n').map((l) => l.split('|')[1]);
        for (const column of ['feedback', 'completed_at', 'plan_id', 'plan_anchor', 'commit_sha']) {
            ok(columns.includes(column), `tasks is missing ${column}`);
            strictEqual(
                query(home, `SELECT count(*) FROM tasks WHERE ${column} IS NOT NULL;`),
                '0',
                `${column} was backfilled with something`,
            );
        }
    });

    it('is idempotent — a second and third init change nothing', () => {
        strictEqual(run(home, ['db', 'init']).code, 0);
        strictEqual(run(home, ['db', 'init']).code, 0);
        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), beforeCount);
        strictEqual(
            query(home, 'SELECT id||"|"||project||"|"||seq||"|"||title FROM tasks ORDER BY id;'),
            before,
        );
    });

    it('keeps the old rows usable through the new surface', () => {
        const listed = run(home, ['task', 'list', '--project', 'github.com/o/beta']);
        strictEqual(listed.code, 0);
        strictEqual(listed.out.split('\n').length, 7);
        match(listed.out, /^#007\|task\|Row 14 for github\.com\/o\/beta\|/);
    });
});

/**
 * The case above starts from a database with none of the additive columns, and
 * its idempotency check covers a database with all of them. The live database
 * is neither: the shipped `db init` already adds `feedback` and `completed_at`,
 * so every real database arrives here holding exactly those two and missing the
 * three plan columns.
 *
 * That partial state is the only migration path a user will actually take, and
 * it is the one a per-column filter can get wrong — an all-or-nothing guard
 * (`if feedback missing, add all five`) passes both cases above and silently
 * skips the plan columns here, leaving `plan_id` absent on a database that
 * reports itself migrated.
 */
describe('db init — partial migration, the state of the live database', () => {
    const home = newHome();
    const PARTIAL_SCHEMA = OLD_SCHEMA.replace(
        '    UNIQUE(project,seq)',
        '    feedback TEXT,\n    completed_at TEXT,\n    UNIQUE(project,seq)',
    );

    exec(home, `${PARTIAL_SCHEMA}
        INSERT INTO tasks(id,project,seq,type,title,priority,status,created,in_changelog,completed_at)
        VALUES(1,'github.com/o/alpha',1,'task','Already completed','medium','completed','2026-01-01 08:00',1,'2026-02-02 09:30');
        INSERT INTO tasks(id,project,seq,type,title,priority,status,created,in_changelog,feedback)
        VALUES(2,'github.com/o/alpha',2,'fix','Has feedback','high','pending','2026-01-02 08:00',0,'needs a retry');`);

    it('starts holding exactly the two shipped columns and none of the plan columns', () => {
        const columns = query(home, 'PRAGMA table_info(tasks);').split('\n').map((l) => l.split('|')[1]);
        ok(columns.includes('feedback'));
        ok(columns.includes('completed_at'));
        ok(!columns.includes('plan_id'));
        strictEqual(run(home, ['db', 'init']).code, 0);
    });

    it('adds only the three missing columns', () => {
        const columns = query(home, 'PRAGMA table_info(tasks);').split('\n').map((l) => l.split('|')[1]);
        for (const column of ['plan_id', 'plan_anchor', 'commit_sha']) {
            ok(columns.includes(column), `tasks is missing ${column}`);
        }
    });

    it('preserves data in the columns it did not add', () => {
        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), '2');
        strictEqual(query(home, 'SELECT completed_at FROM tasks WHERE id=1;'), '2026-02-02 09:30');
        strictEqual(query(home, 'SELECT feedback FROM tasks WHERE id=2;'), 'needs a retry');
    });

    it('leaves the plan columns NULL and the foreign key live', () => {
        strictEqual(query(home, 'SELECT count(*) FROM tasks WHERE plan_id IS NOT NULL;'), '0');
        const r = run(home, ['task', 'add', '--project', 'github.com/o/alpha', '--type', 'task', '--title', 'Orphan', '--plan-id', '999']);
        notStrictEqual(r.code, 0);
        match(r.err, /FOREIGN KEY constraint failed/);
    });
});

// ── foreign keys are genuinely on ─────────────────────────────

describe('foreign key enforcement', () => {
    it('rejects a task whose plan_id does not exist', () => {
        const home = initialized();
        const r = run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'Orphan', '--plan-id', '999']);
        notStrictEqual(r.code, 0);
        match(r.err, /FOREIGN KEY constraint failed/);
    });

    it('leaves no row behind when the foreign key rejects the insert', () => {
        const home = initialized();
        run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'Orphan', '--plan-id', '999']);
        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), '0');
    });

    it('says the transaction rolled back rather than leaving the caller guessing', () => {
        const home = initialized();
        const r = run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'Orphan', '--plan-id', '999']);
        match(r.err, /rolled back/);
    });

    it('accepts a task whose plan_id does exist', () => {
        const home = initialized();
        const planId = seedPlan(home);
        const r = run(home, [
            'task', 'add', '--project', 'testproj', '--type', 'task',
            '--title', 'Step one', '--plan-id', String(planId), '--anchor', 'Step 1: Do the thing',
        ]);
        strictEqual(r.code, 0);
        strictEqual(r.out, '#001');
        strictEqual(query(home, 'SELECT plan_anchor FROM tasks WHERE seq=1;'), 'step-1-do-the-thing');
    });

    it('blocks deleting a plan that still has child tasks (ON DELETE RESTRICT)', () => {
        const home = initialized();
        const planId = seedPlan(home);
        run(home, [
            'task', 'add', '--project', 'testproj', '--type', 'task',
            '--title', 'Child', '--plan-id', String(planId), '--anchor', 'child',
        ]);
        const r = exec(home, `DELETE FROM plans WHERE id=${planId};`);
        notStrictEqual(r.code, 0);
        match(r.err, /FOREIGN KEY constraint failed/);
        strictEqual(query(home, 'SELECT count(*) FROM plans;'), '1');
    });

    it('allows deleting a plan once its children are gone', () => {
        const home = initialized();
        const planId = seedPlan(home);
        run(home, [
            'task', 'add', '--project', 'testproj', '--type', 'task',
            '--title', 'Child', '--plan-id', String(planId), '--anchor', 'child',
        ]);
        exec(home, 'DELETE FROM tasks;');
        strictEqual(exec(home, `DELETE FROM plans WHERE id=${planId};`).code, 0);
    });
});

// ── anchors ───────────────────────────────────────────────────

describe('task add — anchor idempotency', () => {
    it('inserts once and reports the same #NNN on a re-run', () => {
        const home = initialized();
        const planId = seedPlan(home);
        const args = (title: string, anchor: string) => [
            'task', 'add', '--project', 'testproj', '--type', 'task',
            '--title', title, '--plan-id', String(planId), '--anchor', anchor,
        ];

        const first = run(home, args('Step one', 'Step 1: Do the thing'));
        // The raw heading and its slug are the same anchor — that is the whole
        // point of normalizing on input.
        const second = run(home, args('Step one', 'step-1-do-the-thing'));

        strictEqual(first.code, 0);
        strictEqual(second.code, 0);
        strictEqual(first.out, second.out);
        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), '1');
    });

    it('keeps anchors distinct per plan, so two plans may share a step name', () => {
        const home = initialized();
        const a = seedPlan(home, 'testproj', 1);
        const b = seedPlan(home, 'testproj', 2);
        run(home, ['task', 'add', '--project', 'testproj', '--type', 'task', '--title', 'S', '--plan-id', String(a), '--anchor', 'shared']);
        run(home, ['task', 'add', '--project', 'testproj', '--type', 'task', '--title', 'S', '--plan-id', String(b), '--anchor', 'shared']);
        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), '2');
    });

    it('does not treat two plan-less tasks as colliding', () => {
        const home = initialized();
        run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'One']);
        run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'Two']);
        strictEqual(query(home, 'SELECT count(*) FROM tasks;'), '2');
    });
});

// ── transactions and notes ────────────────────────────────────

/**
 * `references/plans.md` defines a non-empty drift indicator as "a candidate is
 * staged OR the linked file no longer matches the applied hash". Only the file
 * half was implemented, so an inline plan holding an unapplied proposal
 * reported `n/a` — the reader is told there is nothing to see while a staged
 * candidate waits.
 *
 * The staging columns are seeded directly here because `plan propose` does not
 * exist yet. That is the point: the read side has to be correct before the
 * write side arrives, or the write side ships against a helper that cannot
 * observe it.
 */
/**
 * A raw NUL byte in `plan-sync.mjs` (an in-band diff sentinel, written
 * literally) made the file binary to `grep` and to `git`'s diff heuristic. Git
 * only sniffs the first 8000 bytes, so it happened to still render the file as
 * text — meaning the damage was invisible right up until someone moved the
 * constant nearer the top and a source file dropped out of reviewable history.
 *
 * Control characters belong in escapes, not literals. This is cheap enough to
 * run over every source file, and the failure mode it guards is silent.
 */
/**
 * The spec requires that moving a child to `in_progress` promotes its plan
 * `pending → in_progress` in the same invocation, and `references/plans.md`
 * tells the skill never to set a plan's status by hand because of it. Nothing
 * implemented it, so plans stayed `pending` while their children ran — a silent
 * failure, since every reader of plan status believed the plan had not started.
 *
 * The negative cases matter more than the positive one here: a promotion that
 * fires too eagerly drags a finished plan backwards, which is worse than one
 * that never fires at all.
 */
/**
 * The spec requires `task list` and `task changelog list` to carry a trailing
 * `P###`, and SKILL.md documents that shape — but neither command selected it,
 * so the column was simply absent. Found by exercising the skill end to end
 * rather than by any test, because every existing assertion had been written
 * against the output as it was.
 *
 * The cross-project label is the part with teeth. `plans.seq` is project-local,
 * so a bare `P001` on a task whose plan lives elsewhere names a different plan
 * than `P001` does in the reader's own project. Acting on the unqualified label
 * finds a real plan and the wrong one, with nothing to signal the mistake.
 */
/**
 * The changelog dated rows by `updated`, which is the last time the row was
 * touched rather than when the work finished. Any later edit — a tag, a
 * feedback note — silently re-dates a completed task and re-sorts the changelog
 * with it. `completed_at` is now written, so it is the honest source, with
 * `updated` kept as the fallback for rows predating that column.
 */
describe('task changelog list — dates by completion, not last edit', () => {
    it('prefers completed_at over a later updated', () => {
        const home = initialized();
        run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'Done']);
        run(home, ['task', 'update', '--project', 'p', '--seq', '1', '--status', 'completed', '--completed-at', '2026-01-15 09:00']);
        // A later, unrelated edit moves `updated` but must not move the date.
        run(home, ['task', 'update', '--project', 'p', '--seq', '1', '--tag', 'late-edit']);
        match(run(home, ['task', 'changelog', 'list', '--project', 'p']).out, /^1\|2026-01-15\|/);
    });

    it('falls back to updated when completed_at is absent', () => {
        const home = initialized();
        exec(
            home,
            `INSERT INTO tasks(project,seq,type,title,status,created,updated,in_changelog)
              VALUES('p',1,'task','Legacy','completed','2026-01-01 00:00','2026-02-20 11:00',0);`,
        );
        match(run(home, ['task', 'changelog', 'list', '--project', 'p']).out, /^1\|2026-02-20\|/);
    });
});

describe('task list / changelog list — the trailing plan label', () => {
    function seeded() {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'proj', '--title', 'Local']);
        run(home, ['plan', 'create', '--project', 'other/repo', '--title', 'Foreign']);
        const local = query(home, "SELECT id FROM plans WHERE project='proj';");
        const foreign = query(home, "SELECT id FROM plans WHERE project='other/repo';");
        run(home, ['task', 'add', '--project', 'proj', '--type', 'task', '--title', 'Own', '--plan-id', local, '--anchor', 'own']);
        run(home, ['task', 'add', '--project', 'proj', '--type', 'task', '--title', 'Foreign', '--plan-id', foreign, '--anchor', 'foreign']);
        run(home, ['task', 'add', '--project', 'proj', '--type', 'task', '--title', 'None']);
        return home;
    }
    const labels = (out: string) => out.split('\n').map((line) => line.split('|').pop());

    it('labels same-project, cross-project and plan-less rows distinctly', () => {
        const home = seeded();
        // Listed newest first: None, Foreign, Own.
        deepStrictEqual(labels(run(home, ['task', 'list', '--project', 'proj']).out), [
            '', 'P001 (other/repo)', 'P001',
        ]);
    });

    it('qualifies a foreign plan whose seq collides with a local one', () => {
        const home = seeded();
        const out = run(home, ['task', 'list', '--project', 'proj']).out;
        const [foreign, own] = [out.split('\n')[1], out.split('\n')[2]];
        notStrictEqual(
            foreign.split('|').pop(),
            own.split('|').pop(),
            'two different plans both numbered P001 must not render identically',
        );
    });

    it('carries the same label through task changelog list', () => {
        const home = seeded();
        for (const seq of ['1', '2', '3']) {
            run(home, ['task', 'update', '--project', 'proj', '--seq', seq, '--status', 'completed', '--completed-at', '2026-08-14 10:00']);
        }
        const found = labels(run(home, ['task', 'changelog', 'list', '--project', 'proj']).out).sort();
        deepStrictEqual(found, ['', 'P001', 'P001 (other/repo)']);
    });
});

describe('task update — plan auto-advance', () => {
    function planWithChild(home: string, planStatus = 'pending') {
        exec(
            home,
            `INSERT INTO plans(project,seq,title,source,status,created)
              VALUES('proj',1,'Plan','inline','${planStatus}','2026-08-14 09:00');
             INSERT INTO tasks(project,seq,type,title,status,created,plan_id)
              VALUES('proj',1,'task','Child','pending','2026-08-14 09:00',
                     (SELECT id FROM plans WHERE project='proj' AND seq=1));`,
        );
    }
    const planStatus = (home: string) => query(home, "SELECT status FROM plans WHERE seq=1;");

    it('promotes a pending plan when its first child starts', () => {
        const home = initialized();
        planWithChild(home);
        strictEqual(run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--status', 'in_progress']).code, 0);
        strictEqual(planStatus(home), 'in_progress');
    });

    it('does not drag a completed plan backwards', () => {
        const home = initialized();
        planWithChild(home, 'completed');
        run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--status', 'in_progress']);
        strictEqual(planStatus(home), 'completed');
    });

    it('does not resurrect a cancelled plan', () => {
        const home = initialized();
        planWithChild(home, 'cancelled');
        run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--status', 'in_progress']);
        strictEqual(planStatus(home), 'cancelled');
    });

    it('leaves the plan alone for any status other than in_progress', () => {
        const home = initialized();
        planWithChild(home);
        run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--status', 'completed']);
        strictEqual(planStatus(home), 'pending');
    });

    it('is a no-op for a plan-less task rather than an error', () => {
        const home = initialized();
        run(home, ['task', 'add', '--project', 'proj', '--type', 'task', '--title', 'Loner']);
        const r = run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--status', 'in_progress']);
        strictEqual(r.code, 0);
        strictEqual(query(home, 'SELECT count(*) FROM plans;'), '0');
    });

    it('promotes the plan a task was just moved to, not the one it left', () => {
        const home = initialized();
        planWithChild(home);
        exec(
            home,
            `INSERT INTO plans(project,seq,title,source,status,created)
              VALUES('proj',2,'Other plan','inline','pending','2026-08-14 09:00');`,
        );
        const other = query(home, "SELECT id FROM plans WHERE seq=2;");
        run(home, [
            'task', 'update', '--project', 'proj', '--seq', '1',
            '--plan-id', other, '--status', 'in_progress',
        ]);
        strictEqual(query(home, "SELECT status FROM plans WHERE seq=2;"), 'in_progress');
        strictEqual(planStatus(home), 'pending');
    });
});

describe('task update — clearing the plan link', () => {
    function planWithChild(home: string) {
        exec(
            home,
            `INSERT INTO plans(project,seq,title,source,status,created)
              VALUES('proj',1,'Plan','inline','pending','2026-08-14 09:00');
             INSERT INTO tasks(project,seq,type,title,status,created,plan_id,plan_anchor)
              VALUES('proj',1,'task','Child','pending','2026-08-14 09:00',
                     (SELECT id FROM plans WHERE project='proj' AND seq=1),'step-one');`,
        );
    }
    const clearedBoth = (home: string) =>
        query(home, 'SELECT count(*) FROM tasks WHERE seq=1 AND plan_id IS NULL AND plan_anchor IS NULL;');

    it('clears both plan_id and plan_anchor to NULL', () => {
        const home = initialized();
        planWithChild(home);
        strictEqual(run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--clear-plan']).code, 0);
        strictEqual(clearedBoth(home), '1');
    });

    it('leaves other columns untouched and still advances updated', () => {
        const home = initialized();
        planWithChild(home);
        const before = query(home, 'SELECT updated FROM tasks WHERE seq=1;');
        run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--clear-plan']);
        strictEqual(query(home, 'SELECT status FROM tasks WHERE seq=1;'), 'pending');
        strictEqual(query(home, 'SELECT title FROM tasks WHERE seq=1;'), 'Child');
        notStrictEqual(query(home, 'SELECT updated FROM tasks WHERE seq=1;'), before);
    });

    it('combined with --status in_progress nulls plan_id but leaves the plan alone (auto-advance no-ops)', () => {
        const home = initialized();
        planWithChild(home);
        run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--clear-plan', '--status', 'in_progress']);
        strictEqual(clearedBoth(home), '1');
        strictEqual(query(home, "SELECT status FROM plans WHERE seq=1;"), 'pending');
    });

    it('combined with --commit-sha nulls the plan columns and sets commit_sha', () => {
        const home = initialized();
        planWithChild(home);
        run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--clear-plan', '--commit-sha', 'deadbeef']);
        strictEqual(clearedBoth(home), '1');
        strictEqual(query(home, 'SELECT commit_sha FROM tasks WHERE seq=1;'), 'deadbeef');
    });

    it('succeeds (exit 0) on an already plan-less task', () => {
        const home = initialized();
        run(home, ['task', 'add', '--project', 'proj', '--type', 'task', '--title', 'Loner']);
        strictEqual(run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--clear-plan']).code, 0);
    });

    it('clearing two different plan-less tasks in sequence does not trip the partial unique index', () => {
        // idx_tasks_plan_anchor is WHERE plan_anchor IS NOT NULL, so two NULL
        // anchors from --clear-plan must not collide with each other.
        const home = initialized();
        run(home, ['task', 'add', '--project', 'proj', '--type', 'task', '--title', 'One']);
        run(home, ['task', 'add', '--project', 'proj', '--type', 'task', '--title', 'Two']);
        strictEqual(run(home, ['task', 'update', '--project', 'proj', '--seq', '1', '--clear-plan']).code, 0);
        strictEqual(run(home, ['task', 'update', '--project', 'proj', '--seq', '2', '--clear-plan']).code, 0);
    });
});

describe('sources are text, not accidentally binary', () => {
    const SOURCES = [
        'lib/cli.mjs', 'lib/db.mjs', 'lib/handlers.mjs', 'lib/normalize.mjs',
        'lib/plan-read.mjs', 'lib/plan-sync.mjs', 'lib/registry.mjs', 'lib/schema.mjs',
        'bin/task-db',
    ];

    for (const relative of SOURCES) {
        it(`${relative} contains no control characters`, () => {
            const text = readFileSync(join(HERE, relative), 'utf-8');
            // Tab, newline and carriage return are the legitimate ones.
            const offending = [...text].filter((ch) => {
                const code = ch.charCodeAt(0);
                return (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') || code === 0x7f;
            });
            deepStrictEqual(
                offending.map((ch) => `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`),
                [],
                `${relative} embeds a literal control character; write it as an escape`,
            );
        });
    }
});

describe('lib/db.mjs — planDrift sees staged candidates', () => {
    it('reports staged for an inline plan with a pending candidate', async () => {
        const { planDrift } = await import(DB_URL);
        strictEqual(
            planDrift({ source: 'inline', path: null, content_hash: 'abc', pending_hash: 'def' }),
            'staged',
        );
    });

    it('still reports n/a for an inline plan with nothing staged', async () => {
        const { planDrift } = await import(DB_URL);
        strictEqual(
            planDrift({ source: 'inline', path: null, content_hash: 'abc', pending_hash: null }),
            'n/a',
        );
    });

    it('prefers staged over the file comparison for a linked plan', async () => {
        const { planDrift } = await import(DB_URL);
        const file = join(mkdtempSync(join(tmpdir(), 'task-db-drift-')), 'plan.md');
        writeFileSync(file, 'body that does not match the applied hash');
        strictEqual(
            planDrift({ source: 'linked', path: file, content_hash: 'stale', pending_hash: null }),
            'drifted',
        );
        strictEqual(
            planDrift({ source: 'linked', path: file, content_hash: 'stale', pending_hash: 'def' }),
            'staged',
        );
    });

    it('throws rather than assuming nothing is staged when the field is absent', async () => {
        const { planDrift } = await import(DB_URL);
        let threw: unknown = null;
        try {
            planDrift({ source: 'inline', path: null, content_hash: 'abc' } as any);
        } catch (err) {
            threw = err;
        }
        ok(threw instanceof Error, 'a partial row should throw, not silently report n/a');
        match(String((threw as Error).message), /pending_hash/);
    });

    it('surfaces staged through plan list, not just the helper', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline plan']);
        strictEqual(run(home, ['plan', 'list', '--project', 'testproj']).out.split('|').pop(), 'n/a');

        exec(home, "UPDATE plans SET pending_content='new body', pending_hash='deadbeef', pending_at='2026-08-14 09:00' WHERE seq=1;");
        strictEqual(run(home, ['plan', 'list', '--project', 'testproj']).out.split('|').pop(), 'staged');
    });
});

describe('lib/db.mjs — transactions and addNote', () => {
    it('rolls the whole batch back when any statement fails', async () => {
        const home = initialized();
        process.env.PROJECT_TASKS_HOME = home;
        const { transaction, DbError } = await import(DB_URL);

        exec(home, "INSERT INTO tasks(project,seq,type,title,created) VALUES('p',1,'task','kept','2026-01-01 00:00');");
        let threw: unknown = null;
        try {
            transaction([
                "UPDATE tasks SET title='mutated' WHERE seq=1;",
                'UPDATE tasks SET plan_id=999 WHERE seq=1;', // FK violation
            ]);
        } catch (err) {
            threw = err;
        }
        ok(threw instanceof DbError);
        match(String((threw as Error).message), /rolled back/);
        strictEqual(query(home, 'SELECT title FROM tasks WHERE seq=1;'), 'kept');
    });

    it('allocates note ids as MAX(id)+1 and never reuses one', async () => {
        const home = initialized();
        process.env.PROJECT_TASKS_HOME = home;
        const { addNote } = await import(DB_URL);
        const planId = seedPlan(home);

        addNote(planId, 'created', { note: 'first' });
        addNote(planId, 'manual', { note: 'second' });
        addNote(planId, 'manual', { note: 'third' });
        strictEqual(query(home, `SELECT group_concat(json_extract(value,'$.id')) FROM plans, json_each(plans.notes) WHERE plans.id=${planId};`), '1,2,3');

        // Deleting the middle note must not make the next allocation reuse its id,
        // or a `list` → `delete` sequence would hit the wrong entry.
        exec(
            home,
            `UPDATE plans SET notes=(SELECT json_group_array(json(value)) FROM json_each(plans.notes)
              WHERE json_extract(value,'$.id')!=2) WHERE id=${planId};`,
        );
        addNote(planId, 'manual', { note: 'fourth' });
        strictEqual(query(home, `SELECT group_concat(json_extract(value,'$.id')) FROM plans, json_each(plans.notes) WHERE plans.id=${planId};`), '1,3,4');
    });

    it('keeps prose with quotes and newlines valid JSON', async () => {
        const home = initialized();
        process.env.PROJECT_TASKS_HOME = home;
        const { addNote } = await import(DB_URL);
        const planId = seedPlan(home);

        const nasty = `it's "quoted", has\na newline, a ');DROP TABLE tasks;--' and a \\backslash`;
        addNote(planId, 'manual', { note: nasty, tasks: [12, 13] });

        strictEqual(query(home, `SELECT json_valid(notes) FROM plans WHERE id=${planId};`), '1');
        strictEqual(query(home, `SELECT json_extract(notes,'$[0].note') FROM plans WHERE id=${planId};`), nasty.replace(/\n/g, '\n'));
        strictEqual(query(home, `SELECT json_extract(notes,'$[0].tasks[1]') FROM plans WHERE id=${planId};`), '13');
        // The injection attempt is data, not SQL.
        ok(query(home, "SELECT name FROM sqlite_master WHERE name='tasks';") === 'tasks');
    });

    it('gives concurrent writers unique, monotonic note ids', async () => {
        const home = initialized();
        const planId = seedPlan(home);
        const workers = 8;

        await Promise.all(
            Array.from({ length: workers }, (_, i) =>
                new Promise<void>((resolve, reject) => {
                    const script =
                        `import { addNote } from ${JSON.stringify(DB_URL)};\n` +
                        `addNote(${planId}, 'manual', { note: 'worker-${i}' });\n`;
                    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
                        env: { ...process.env, PROJECT_TASKS_HOME: home },
                        stdio: ['ignore', 'ignore', 'pipe'],
                    });
                    let stderr = '';
                    child.stderr.on('data', (chunk) => { stderr += chunk; });
                    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
                }),
            ),
        );

        const ids = query(
            home,
            `SELECT json_extract(value,'$.id') FROM plans, json_each(plans.notes) WHERE plans.id=${planId} ORDER BY 1;`,
        ).split('\n');
        deepStrictEqual(ids, ['1', '2', '3', '4', '5', '6', '7', '8']);
    });

    it('waits out a short lock instead of failing instantly (busy_timeout is applied)', async () => {
        const home = initialized();
        process.env.PROJECT_TASKS_HOME = home;
        const { transaction } = await import(DB_URL);

        // The lock holder must release on ITS OWN clock. `transaction()` is
        // synchronous and blocks this process's event loop, so a timer here that
        // was supposed to send the COMMIT would never fire — the test would
        // deadlock until busy_timeout expired and then "prove" the opposite of
        // what it meant to.
        const holder = spawn(
            'sh',
            ['-c', `( printf 'BEGIN EXCLUSIVE;\\nINSERT INTO tasks(project,seq,type,title,created) ` +
                `VALUES(%s,1,%s,%s,%s);\\n' "'holder'" "'task'" "'held'" "'2026-01-01 00:00'"; ` +
                `sleep 1; printf 'COMMIT;\\n' ) | sqlite3 -bail '${join(home, 'tasks.db')}'`],
            { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const exited = new Promise<number>((resolve) => holder.on('close', (code) => resolve(code ?? -1)));
        await new Promise((r) => setTimeout(r, 300));

        // Without a busy timeout this throws SQLITE_BUSY within milliseconds.
        const started = Date.now();
        transaction([
            "INSERT INTO tasks(project,seq,type,title,created) VALUES('waiter',1,'task','waited','2026-01-01 00:00');",
        ]);
        const waited = Date.now() - started;

        strictEqual(await exited, 0);
        ok(waited > 300, `the write returned in ${waited}ms — too fast to have waited on the lock`);
        strictEqual(query(home, "SELECT title FROM tasks WHERE project='waiter';"), 'waited');
        strictEqual(query(home, "SELECT title FROM tasks WHERE project='holder';"), 'held');
    });
});

// ── the ported command surface ────────────────────────────────

describe('the 13 ported commands, end to end', () => {
    const home = initialized();

    it('task add prints #NNN and allocates per-project sequences', () => {
        strictEqual(run(home, ['task', 'add', '--project', 'testproj', '--type', 'task', '--title', 'First task']).out, '#001');
        strictEqual(
            run(home, [
                'task', 'add', '--project', 'testproj', '--type', 'fix', '--title', "Second's task",
                '--priority', 'high', '--tag', 'auth', '--tag', 'api', '--dep', '1',
            ]).out,
            '#002',
        );
        strictEqual(run(home, ['task', 'add', '--project', 'other', '--type', 'todo', '--title', 'Elsewhere']).out, '#001');
    });

    it('task list is scoped to its project and hides cancelled rows by default', () => {
        const listed = run(home, ['task', 'list', '--project', 'testproj']);
        deepStrictEqual(listed.out.split('\n'), [
            // The trailing field is the plan label, empty for a plan-less task.
            '#002|fix|Second\'s task|high|pending|["auth","api"]|[1]|',
            '#001|task|First task|medium|pending|[]|[]|',
        ]);
    });

    it('task get returns JSON', () => {
        const parsed = JSON.parse(run(home, ['task', 'get', '--project', 'testproj', '--seq', '2']).out);
        strictEqual(parsed[0].title, "Second's task");
        strictEqual(parsed[0].priority, 'high');
    });

    it('task get returns plan-less tasks with the plan fields null', () => {
        const parsed = JSON.parse(run(home, ['task', 'get', '--project', 'testproj', '--seq', '2']).out);
        strictEqual(parsed.length, 1, 'the LEFT JOIN must not drop plan-less rows');
        strictEqual(parsed[0].plan_id, null);
        strictEqual(parsed[0].plan_seq, null);
        strictEqual(parsed[0].plan_project, null);
    });

    it('task recent honours --limit', () => {
        strictEqual(run(home, ['task', 'recent', '--project', 'testproj', '--limit', '1']).out, '#002|fix|Second\'s task|pending');
    });

    it('task deps check lists incomplete dependencies', () => {
        strictEqual(run(home, ['task', 'deps', 'check', '--project', 'testproj', '--seq', '2']).out, '#001|First task|pending');
    });

    it('task deps blocked lists pending tasks with incomplete dependencies', () => {
        strictEqual(run(home, ['task', 'deps', 'blocked', '--project', 'testproj']).out, '2');
    });

    it('task deps validate names dependencies that do not exist', () => {
        strictEqual(run(home, ['task', 'deps', 'validate', '--project', 'testproj', '--dep', '1', '--dep', '99']).out, '99');
    });

    it('task update writes the mutation and stamps completed_at once', () => {
        strictEqual(run(home, ['task', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed']).code, 0);
        const first = query(home, "SELECT completed_at FROM tasks WHERE project='testproj' AND seq=1;");
        match(first, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

        // Re-completing must not rewrite when the work was actually finished.
        run(home, ['task', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed']);
        strictEqual(query(home, "SELECT completed_at FROM tasks WHERE project='testproj' AND seq=1;"), first);

        // An explicit value still wins.
        run(home, ['task', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed', '--completed-at', '2026-08-09 12:00', '--commit-sha', 'deadbeef']);
        strictEqual(query(home, "SELECT completed_at||'/'||commit_sha FROM tasks WHERE project='testproj' AND seq=1;"), '2026-08-09 12:00/deadbeef');
    });

    it('task deps unblocked reports what the completion released', () => {
        strictEqual(run(home, ['task', 'deps', 'unblocked', '--project', 'testproj', '--seq', '1']).out, '#002|Second\'s task');
    });

    it('task changelog list and mark round-trip through in_changelog', () => {
        match(run(home, ['task', 'changelog', 'list', '--project', 'testproj']).out, /^1\|\d{4}-\d{2}-\d{2}\|task\|First task\|\[\]\|$/);
        notStrictEqual(run(home, ['task', 'changelog', 'list', '--project', 'testproj', '--new-only']).out, '');
        strictEqual(run(home, ['task', 'changelog', 'mark', '--project', 'testproj', '--all']).code, 0);
        strictEqual(run(home, ['task', 'changelog', 'list', '--project', 'testproj', '--new-only']).out, '');
    });

    it('task changelog mark accepts explicit sequences', () => {
        const local = initialized();
        run(local, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'A']);
        run(local, ['task', 'update', '--project', 'p', '--seq', '1', '--status', 'completed']);
        strictEqual(run(local, ['task', 'changelog', 'mark', '--project', 'p', '--seq', '1']).code, 0);
        strictEqual(query(local, 'SELECT in_changelog FROM tasks WHERE seq=1;'), '1');
    });

    it('db migrate rewrites legacy project identifiers and renumbers only the moved rows', () => {
        const local = initialized();
        // The parser normalizes --project, so a legacy name can only reach the
        // table by being written before this rewrite. Seed it directly.
        exec(local, `INSERT INTO tasks(project,seq,type,title,created) VALUES
            ('github.com/o/r',1,'task','existing','2026-01-01 00:00'),
            ('git@github.com:o/r.git',1,'fix','legacy one','2026-01-02 00:00'),
            ('git@github.com:o/r.git',2,'fix','legacy two','2026-01-03 00:00');`);

        const r = run(local, ['db', 'migrate']);
        strictEqual(r.code, 0);
        match(r.out, /git@github\.com:o\/r\.git -> github\.com\/o\/r {2}\(2 rows\)/);
        match(r.out, /Migrated 2 rows across 1 project\./);

        deepStrictEqual(
            query(local, "SELECT seq||'|'||title FROM tasks WHERE project='github.com/o/r' ORDER BY seq;").split('\n'),
            ['1|existing', '2|legacy one', '3|legacy two'],
        );
        strictEqual(run(local, ['db', 'migrate']).out, 'No project names needed migration.');
    });
});

// ── task get resolves the plan display id ─────────────────────

describe('task get — plan resolution', () => {
    it('returns both id spaces for a task that belongs to a plan', () => {
        const home = initialized();
        const planId = seedPlan(home, 'testproj', 1);
        run(home, [
            'task', 'add', '--project', 'testproj', '--type', 'task', '--title', 'Step one',
            '--plan-id', String(planId), '--anchor', 'step-one',
        ]);

        const [row] = JSON.parse(run(home, ['task', 'get', '--project', 'testproj', '--seq', '1']).out);
        // `plan_id` feeds --plan-id; `plan_seq` feeds every `plan *` --seq.
        strictEqual(row.plan_id, planId);
        strictEqual(row.plan_seq, 'P001');
        strictEqual(row.plan_project, 'testproj');
    });

    it("reports the PLAN's own P### and project when the plan lives in another repository", () => {
        const home = initialized();
        // Two plans, so the cross-repo plan's project-local seq (2) is provably
        // different from the P001 a reader would assume from the task's project.
        seedPlan(home, 'backend', 1);
        const frontendPlan = seedPlan(home, 'frontend', 2);

        run(home, [
            'task', 'add', '--project', 'backend', '--type', 'task', '--title', 'Backend step',
            '--plan-id', String(frontendPlan), '--anchor', 'backend-step',
        ]);

        const [row] = JSON.parse(run(home, ['task', 'get', '--project', 'backend', '--seq', '1']).out);
        strictEqual(row.plan_id, frontendPlan);
        // P002, not P001: `plans.seq` is project-local to the plan's OWNER.
        strictEqual(row.plan_seq, 'P002');
        strictEqual(row.plan_project, 'frontend');
    });
});

// ── the hard cutover ──────────────────────────────────────────

describe('legacy flat names', () => {
    const home = initialized();
    for (const [legacy, replacement] of Object.entries(RENAMES)) {
        it(`'${legacy}' errors naming '${replacement.join(' ')}'`, () => {
            const r = run(home, [legacy, '--project', 'p', '--seq', '1']);
            strictEqual(r.code, 1);
            strictEqual(r.out, '');
            match(r.err, new RegExp(`'${legacy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' was renamed`));
            ok(r.err.includes(`'${replacement.join(' ')}'`), r.err);
        });
    }
});

// ── plan surface coverage ─────────────────────────────────────

/**
 * Every plan command in the registry must have a handler wired into `HANDLERS`.
 * The plan family is split across three modules and merged below, so this is
 * the only place a missed merge surfaces — without it, dispatching to
 * `undefined` would crash at runtime rather than at build time.
 */
describe('plan surface coverage', () => {
    it('every plan command has a handler in HANDLERS', () => {
        for (const name of Object.keys(COMMANDS).filter((n) => n.startsWith('plan '))) {
            const handler = (COMMANDS as any)[name].handler;
            ok(handler in HANDLERS, `${name} dispatches to a handler that does not exist`);
        }
    });

    it('routes every plan command without reporting it as unimplemented', () => {
        const home = initialized();
        for (const name of Object.keys(COMMANDS).filter((n) => n.startsWith('plan '))) {
            const result = run(home, canonicalArgv(name));
            ok(!/not implemented|unimplemented/i.test(`${result.out}\n${result.err}`), name);
        }
    });
});

// ── plan create / get / list ──────────────────────────────────

describe('plan create — inline', () => {
    it('creates an empty inline plan when neither --path nor --content-file is given', () => {
        const home = initialized();
        const r = run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Bare plan']);
        strictEqual(r.code, 0);
        strictEqual(r.out, 'P001');
        strictEqual(query(home, "SELECT source||'|'||coalesce(content,'') FROM plans WHERE seq=1;"), 'inline|');
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), '');
        strictEqual(query(home, 'SELECT synced_at FROM plans WHERE seq=1;'), '');
    });

    it('creates an inline plan from --content-file and records --origin', async () => {
        const home = initialized();
        const { sha256 } = await import(DB_URL);
        const src = join(home, 'src.md');
        writeFileSync(src, '# Imported\n\nBody text.\n');
        const r = run(home, [
            'plan', 'create', '--project', 'testproj', '--title', 'Imported plan',
            '--content-file', src, '--origin', src,
        ]);
        strictEqual(r.code, 0);
        strictEqual(r.out, 'P001');
        strictEqual(query(home, 'SELECT source FROM plans WHERE seq=1;'), 'inline');
        strictEqual(query(home, 'SELECT origin_path FROM plans WHERE seq=1;'), src);
        strictEqual(query(home, 'SELECT path FROM plans WHERE seq=1;'), '');
        strictEqual(query(home, 'SELECT content FROM plans WHERE seq=1;'), '# Imported\n\nBody text.');
        strictEqual(query(home, 'SELECT content_hash FROM plans WHERE seq=1;'), sha256('# Imported\n\nBody text.\n'));
        strictEqual(query(home, 'SELECT synced_at FROM plans WHERE seq=1;'), '');
    });

    it('records tags', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T', '--tag', 'auth', '--tag', 'urgent']);
        const [row] = JSON.parse(run(home, ['plan', 'get', '--project', 'testproj', '--seq', '1']).out);
        strictEqual(row.tags, '["auth","urgent"]');
    });

    it('writes exactly one auto-note of kind created', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T']);
        const parsed = JSON.parse(query(home, 'SELECT notes FROM plans WHERE seq=1;'));
        strictEqual(parsed.length, 1);
        strictEqual(parsed[0].id, 1);
        strictEqual(parsed[0].kind, 'created');
    });
});

describe('plan create — linked', () => {
    it('snapshots source bytes before a later filesystem read can observe an edit', async () => {
        const home = initialized();
        const source = join(home, 'source.md');
        const first = '# First version\n';
        const second = '# Second version\n';
        writeFileSync(source, first);

        const { sourceSnapshot } = await import(DB_URL);
        strictEqual(typeof sourceSnapshot, 'function');
        const snapshot = sourceSnapshot(source);
        try {
            writeFileSync(source, second);
            strictEqual(snapshot.text, first);
            strictEqual(snapshot.hash, (await import(DB_URL)).sha256(first));
        } finally {
            snapshot.cleanup();
        }
    });

    it('sets source=linked, path, content, content_hash and synced_at from the live file', () => {
        const home = initialized();
        const file = join(home, 'plan.md');
        writeFileSync(file, '# Linked plan\n');
        const r = run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Linked', '--path', file]);
        strictEqual(r.code, 0);
        strictEqual(r.out, 'P001');
        strictEqual(query(home, "SELECT source||'|'||path FROM plans WHERE seq=1;"), `linked|${file}`);
        strictEqual(query(home, 'SELECT content FROM plans WHERE seq=1;'), '# Linked plan');
        strictEqual(query(home, 'SELECT origin_path FROM plans WHERE seq=1;'), '');
        notStrictEqual(query(home, 'SELECT synced_at FROM plans WHERE seq=1;'), '');
    });

    it('rejects --path together with --content-file', () => {
        const home = initialized();
        const r = run(home, [
            'plan', 'create', '--project', 'testproj', '--title', 'X',
            '--path', '/tmp/a.md', '--content-file', '/tmp/b.md',
        ]);
        notStrictEqual(r.code, 0);
        match(r.err, /mutually exclusive/);
        strictEqual(query(home, 'SELECT count(*) FROM plans;'), '0');
    });

    it('errors actionably when --path does not exist, without touching the database', () => {
        const home = initialized();
        const r = run(home, [
            'plan', 'create', '--project', 'testproj', '--title', 'Missing',
            '--path', join(home, 'nope.md'),
        ]);
        notStrictEqual(r.code, 0);
        match(r.err, /cannot read/);
        strictEqual(query(home, 'SELECT count(*) FROM plans;'), '0');
    });
});

describe('plan create — seq allocation', () => {
    it('allocates per-project sequences independently, starting at 1', () => {
        const home = initialized();
        strictEqual(run(home, ['plan', 'create', '--project', 'a', '--title', 'A1']).out, 'P001');
        strictEqual(run(home, ['plan', 'create', '--project', 'a', '--title', 'A2']).out, 'P002');
        strictEqual(run(home, ['plan', 'create', '--project', 'b', '--title', 'B1']).out, 'P001');
    });

    it('gives concurrent creators in the same project distinct, gap-free sequences', async () => {
        const home = initialized();
        const workers = 6;
        await Promise.all(
            Array.from({ length: workers }, (_, i) =>
                new Promise<void>((resolve, reject) => {
                    const child = spawn(
                        process.execPath,
                        [BIN, 'plan', 'create', '--project', 'race', '--title', `T${i}`],
                        { env: { ...process.env, PROJECT_TASKS_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] },
                    );
                    let stderr = '';
                    child.stderr.on('data', (c) => { stderr += c; });
                    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
                }),
            ),
        );
        strictEqual(
            query(home, "SELECT seq FROM plans WHERE project='race' ORDER BY seq;").split('\n').join(','),
            '1,2,3,4,5,6',
        );
    });
});

describe('plan get', () => {
    it('default JSON includes the global id and excludes content', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T']);
        const [row] = JSON.parse(run(home, ['plan', 'get', '--project', 'testproj', '--seq', '1']).out);
        ok(Number.isInteger(row.id));
        strictEqual(row.seq, 1);
        strictEqual(row.title, 'T');
        strictEqual('content' in row, false);
    });

    it('--with-content adds the body', () => {
        const home = initialized();
        const file = join(home, 'p.md');
        writeFileSync(file, 'Body\n');
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T', '--path', file]);
        const [row] = JSON.parse(
            run(home, ['plan', 'get', '--project', 'testproj', '--seq', '1', '--with-content']).out,
        );
        strictEqual(row.content, 'Body\n');
    });

    it('--content-only prints the raw body with no JSON wrapper', () => {
        const home = initialized();
        const file = join(home, 'p.md');
        writeFileSync(file, '# Heading\n\nText.\n');
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T', '--path', file]);
        const r = run(home, ['plan', 'get', '--project', 'testproj', '--seq', '1', '--content-only']);
        strictEqual(r.code, 0);
        strictEqual(r.out, '# Heading\n\nText.');
    });

    it('--content-only --output-file round-trips byte-for-byte, including trailing blank lines', () => {
        const home = initialized();
        const file = join(home, 'p.md');
        writeFileSync(file, '# Heading\n\ntrailing blank line above\n\n');
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T', '--path', file]);
        const target = join(home, 'restored.md');
        const r = run(home, [
            'plan', 'get', '--project', 'testproj', '--seq', '1', '--content-only', '--output-file', target,
        ]);
        strictEqual(r.code, 0);
        strictEqual(readFileSync(target, 'utf-8'), readFileSync(file, 'utf-8'));
    });

    it('--with-content and --content-only are mutually exclusive', () => {
        const home = initialized();
        const r = run(home, ['plan', 'get', '--project', 'p', '--seq', '1', '--with-content', '--content-only']);
        notStrictEqual(r.code, 0);
        match(r.err, /mutually exclusive/);
    });
});

describe('plan list', () => {
    it('reports done/total from child tasks and P%03d formatting', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'With tasks']);
        const planId = Number(query(home, 'SELECT id FROM plans WHERE seq=1;'));
        run(home, ['task', 'add', '--project', 'testproj', '--type', 'task', '--title', 'S1', '--plan-id', String(planId), '--anchor', 's1']);
        run(home, ['task', 'add', '--project', 'testproj', '--type', 'task', '--title', 'S2', '--plan-id', String(planId), '--anchor', 's2']);
        run(home, ['task', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed']);

        strictEqual(run(home, ['plan', 'list', '--project', 'testproj']).out, 'P001|With tasks|inline|pending|1|2|n/a');
    });

    it('drift is n/a for an inline plan', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Inline']);
        match(run(home, ['plan', 'list', '--project', 'testproj']).out, /\|n\/a$/);
    });

    it('drift is clean for a linked plan whose file matches the stored hash', () => {
        const home = initialized();
        const file = join(home, 'p.md');
        writeFileSync(file, 'same\n');
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Linked', '--path', file]);
        match(run(home, ['plan', 'list', '--project', 'testproj']).out, /\|clean$/);
    });

    it('drift is drifted for a linked plan whose file changed since create', () => {
        const home = initialized();
        const file = join(home, 'p.md');
        writeFileSync(file, 'original\n');
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Linked', '--path', file]);
        writeFileSync(file, 'edited\n');
        match(run(home, ['plan', 'list', '--project', 'testproj']).out, /\|drifted$/);
    });

    it('drift is missing for a linked plan whose file has been deleted', () => {
        const home = initialized();
        const file = join(home, 'p.md');
        writeFileSync(file, 'gone soon\n');
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Linked', '--path', file]);
        rmSync(file);
        match(run(home, ['plan', 'list', '--project', 'testproj']).out, /\|missing$/);
    });

    it('hides cancelled plans by default and --status filters exactly', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Pending one']);
        seedPlan(home, 'testproj', 2);
        exec(home, "UPDATE plans SET status='cancelled' WHERE project='testproj' AND seq=2;");

        const defaultOut = run(home, ['plan', 'list', '--project', 'testproj']).out;
        ok(!defaultOut.includes('P002'), 'cancelled plan should be hidden by default');

        const filtered = run(home, ['plan', 'list', '--project', 'testproj', '--status', 'cancelled']).out;
        ok(filtered.includes('P002'));
    });

    it('honours the shared --output-file mechanism with no per-handler special case', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T']);
        const target = join(home, 'list.txt');
        const r = run(home, ['plan', 'list', '--project', 'testproj', '--output-file', target]);
        strictEqual(r.code, 0);
        ok(existsSync(target));
        match(readFileSync(target, 'utf-8'), /^P001\|T\|inline\|pending\|0\|0\|n\/a\n$/);
    });
});

// ── plan note add / list / replace / delete ───────────────────

describe('plan note add', () => {
    it('appends a manual note with the current timestamp and given tasks', () => {
        const home = initialized();
        const planId = seedPlan(home);
        const r = run(home, [
            'plan', 'note', 'add', '--project', 'testproj', '--seq', '1',
            '--note', 'rescoped after review', '--task', 'github.com/acme/backend#001', '--task', 'github.com/acme/frontend#002',
        ]);
        strictEqual(r.code, 0);
        const notes = JSON.parse(query(home, `SELECT notes FROM plans WHERE id=${planId};`));
        strictEqual(notes.length, 1);
        strictEqual(notes[0].id, 1);
        strictEqual(notes[0].kind, 'manual');
        strictEqual(notes[0].note, 'rescoped after review');
        deepStrictEqual(notes[0].tasks, [
            { project: 'github.com/acme/backend', seq: 1 },
            { project: 'github.com/acme/frontend', seq: 2 },
        ]);
        match(notes[0].ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('defaults --kind to manual and accepts tasks-created / reconciled', () => {
        const home = initialized();
        const planId = seedPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'batch']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'batch2', '--kind', 'tasks-created']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'batch3', '--kind', 'reconciled']);
        const kinds = JSON.parse(query(home, `SELECT notes FROM plans WHERE id=${planId};`)).map((n: any) => n.kind);
        deepStrictEqual(kinds, ['manual', 'tasks-created', 'reconciled']);
    });

    it('allocates ids as MAX(id)+1 and never reuses one after a delete', () => {
        const home = initialized();
        const planId = seedPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'one']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'two']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'three']);
        run(home, ['plan', 'note', 'delete', '--project', 'testproj', '--seq', '1', '--id', '2']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'four']);
        const ids = JSON.parse(query(home, `SELECT notes FROM plans WHERE id=${planId};`)).map((n: any) => n.id);
        deepStrictEqual(ids, [1, 3, 4]);
    });

    it('errors when the plan does not exist', () => {
        const home = initialized();
        const r = run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '99', '--note', 'x']);
        notStrictEqual(r.code, 0);
        match(r.err, /no plan P099/);
    });
});

describe('plan note add — concurrent writers', () => {
    it('gives concurrent `plan note add` invocations unique, monotonic ids', async () => {
        const home = initialized();
        seedPlan(home);
        const workers = 8;
        await Promise.all(
            Array.from({ length: workers }, (_, i) =>
                new Promise<void>((resolve, reject) => {
                    const child = spawn(
                        process.execPath,
                        [BIN, 'plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', `worker-${i}`],
                        { env: { ...process.env, PROJECT_TASKS_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] },
                    );
                    let stderr = '';
                    child.stderr.on('data', (c) => { stderr += c; });
                    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
                }),
            ),
        );
        const ids = query(
            home,
            `SELECT json_extract(value,'$.id') FROM plans, json_each(plans.notes)
              WHERE plans.project='testproj' AND plans.seq=1 ORDER BY 1;`,
        ).split('\n');
        deepStrictEqual(ids, ['1', '2', '3', '4', '5', '6', '7', '8']);
    });
});

describe('plan note list', () => {
    it('returns notes most-recent-first as a JSON array', () => {
        const home = initialized();
        seedPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'one']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'two']);
        const r = run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0);
        const notes = JSON.parse(r.out);
        deepStrictEqual(notes.map((n: any) => n.note), ['two', 'one']);
    });

    it('honours --limit', () => {
        const home = initialized();
        seedPlan(home);
        for (const n of ['one', 'two', 'three']) {
            run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', n]);
        }
        const r = run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1', '--limit', '2']);
        deepStrictEqual(JSON.parse(r.out).map((n: any) => n.note), ['three', 'two']);
    });

    it('returns an empty array for a plan with no notes', () => {
        const home = initialized();
        seedPlan(home);
        strictEqual(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out, '[]');
    });
});

describe('plan note replace', () => {
    it('preserves id/ts/kind, updates note and tasks, and stamps edited', () => {
        const home = initialized();
        seedPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'original', '--task', 'github.com/acme/backend#001']);
        const [before] = JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out);

        const r = run(home, [
            'plan', 'note', 'replace', '--project', 'testproj', '--seq', '1',
            '--id', '1', '--note', 'revised', '--task', 'github.com/acme/backend#002',
        ]);
        strictEqual(r.code, 0);

        const [after] = JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out);
        strictEqual(after.id, before.id);
        strictEqual(after.ts, before.ts);
        strictEqual(after.kind, before.kind);
        strictEqual(after.note, 'revised');
        deepStrictEqual(after.tasks, [{ project: 'github.com/acme/backend', seq: 2 }]);
        match(after.edited, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('drops tasks that are not repeated on replace (full replace, not a merge)', () => {
        const home = initialized();
        seedPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'original', '--task', 'github.com/acme/backend#001']);
        run(home, ['plan', 'note', 'replace', '--project', 'testproj', '--seq', '1', '--id', '1', '--note', 'revised']);
        const [after] = JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out);
        strictEqual('tasks' in after, false);
    });

    it('preserves unaffected qualified refs as JSON objects through replace and delete', () => {
        const home = initialized();
        seedPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'backend', '--task', 'github.com/acme/backend#001']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'frontend', '--task', 'github.com/acme/frontend#001']);

        run(home, [
            'plan', 'note', 'replace', '--project', 'testproj', '--seq', '1',
            '--id', '1', '--note', 'revised', '--task', 'github.com/acme/backend#002',
        ]);
        let stored = JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out);
        deepStrictEqual(stored.find((n: any) => n.id === 2).tasks, [
            { project: 'github.com/acme/frontend', seq: 1 },
        ]);

        run(home, ['plan', 'note', 'delete', '--project', 'testproj', '--seq', '1', '--id', '1']);
        stored = JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out);
        deepStrictEqual(stored[0].tasks, [{ project: 'github.com/acme/frontend', seq: 1 }]);
    });

    it('refuses to replace a lifecycle note without --force', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T']);
        const r = run(home, ['plan', 'note', 'replace', '--project', 'testproj', '--seq', '1', '--id', '1', '--note', 'tampered']);
        notStrictEqual(r.code, 0);
        match(r.err, /--force/);
        const [note] = JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out);
        strictEqual(note.note, 'Plan created.');
        strictEqual(note.kind, 'created');
    });

    it('replaces a lifecycle note with --force', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T']);
        const r = run(home, [
            'plan', 'note', 'replace', '--project', 'testproj', '--seq', '1',
            '--id', '1', '--note', 'corrected', '--force',
        ]);
        strictEqual(r.code, 0);
        const [note] = JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out);
        strictEqual(note.note, 'corrected');
        strictEqual(note.kind, 'created');
    });

    it('errors when the note id does not exist', () => {
        const home = initialized();
        seedPlan(home);
        const r = run(home, ['plan', 'note', 'replace', '--project', 'testproj', '--seq', '1', '--id', '99', '--note', 'x']);
        notStrictEqual(r.code, 0);
        match(r.err, /no note #99/);
    });
});

describe('plan note delete', () => {
    it('leaves other ids intact and the next allocation at MAX+1', () => {
        const home = initialized();
        const planId = seedPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'one']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'two']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'three']);

        const r = run(home, ['plan', 'note', 'delete', '--project', 'testproj', '--seq', '1', '--id', '2']);
        strictEqual(r.code, 0);

        const ids = JSON.parse(query(home, `SELECT notes FROM plans WHERE id=${planId};`)).map((n: any) => n.id);
        deepStrictEqual(ids, [1, 3]);

        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'four']);
        const idsAfter = JSON.parse(query(home, `SELECT notes FROM plans WHERE id=${planId};`)).map((n: any) => n.id);
        deepStrictEqual(idsAfter, [1, 3, 4]);
    });

    it('refuses to delete a lifecycle note without --force, and succeeds with it', () => {
        const home = initialized();
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'T']);
        const refused = run(home, ['plan', 'note', 'delete', '--project', 'testproj', '--seq', '1', '--id', '1']);
        notStrictEqual(refused.code, 0);
        match(refused.err, /--force/);
        strictEqual(JSON.parse(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out).length, 1);

        const forced = run(home, ['plan', 'note', 'delete', '--project', 'testproj', '--seq', '1', '--id', '1', '--force']);
        strictEqual(forced.code, 0);
        strictEqual(run(home, ['plan', 'note', 'list', '--project', 'testproj', '--seq', '1']).out, '[]');
    });

    it('errors when the note id does not exist', () => {
        const home = initialized();
        seedPlan(home);
        const r = run(home, ['plan', 'note', 'delete', '--project', 'testproj', '--seq', '1', '--id', '99']);
        notStrictEqual(r.code, 0);
        match(r.err, /no note #99/);
    });
});

// ── dispatch plumbing ─────────────────────────────────────────

describe('dispatch', () => {
    it('prints usage and exits 0 for a bare invocation', () => {
        const r = run(initialized(), []);
        strictEqual(r.code, 0);
        match(r.out, /^Usage: task-db <group> <command> \[options\]/);
    });

    it('prints group usage for a namespace with no leaf', () => {
        const r = run(initialized(), ['task', 'deps']);
        strictEqual(r.code, 0);
        match(r.out, /Usage: task-db task deps <subcommand>/);
    });

    it('sends parse errors to stderr with exit 1 and nothing on stdout', () => {
        const r = run(initialized(), ['task', 'get', '--project', 'p']);
        strictEqual(r.code, 1);
        strictEqual(r.out, '');
        match(r.err, /'--seq' is required/);
    });

    it('rejects --project on a db command rather than ignoring it', () => {
        const r = run(initialized(), ['db', 'init', '--project', 'p']);
        strictEqual(r.code, 1);
        match(r.err, /'--project' is not accepted/);
    });

    it('reports a missing sqlite3 actionably', () => {
        const home = initialized();
        const r = spawnSync(process.execPath, [BIN, 'task', 'list', '--project', 'p'], {
            env: { ...process.env, PROJECT_TASKS_HOME: home, PATH: '/nonexistent' },
            encoding: 'utf-8',
        });
        notStrictEqual(r.status, 0);
        match(r.stderr ?? '', /'sqlite3' was not found on PATH/);
    });
});

// ── --output-file ─────────────────────────────────────────────

describe('--output-file', () => {
    it('writes the payload to the file and only a confirmation to stdout', () => {
        const home = initialized();
        run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'A']);
        const target = join(home, 'nested', 'deeper', 'list.txt');

        const r = run(home, ['task', 'list', '--project', 'p', '--output-file', target]);
        strictEqual(r.code, 0);
        ok(existsSync(target), 'parent directories should be created');

        const body = readFileSync(target, 'utf-8');
        strictEqual(body, '#001|task|A|medium|pending|[]|[]|\n');
        strictEqual(r.out, `${Buffer.byteLength(body)} bytes → ${target}`);
        ok(!r.out.includes('#001'), 'the payload must not also go to stdout');
    });

    it('overwrites an existing file', () => {
        const home = initialized();
        const target = join(home, 'out.txt');
        run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'A']);
        run(home, ['task', 'list', '--project', 'p', '--output-file', target]);
        run(home, ['task', 'add', '--project', 'p', '--type', 'task', '--title', 'B']);
        run(home, ['task', 'list', '--project', 'p', '--output-file', target]);
        strictEqual(readFileSync(target, 'utf-8').split('\n').filter(Boolean).length, 2);
    });

    it('does not disturb the exit code', () => {
        const home = newHome();
        strictEqual(run(home, ['db', 'init']).code, 2);
        const r = run(home, ['task', 'get', '--project', 'p', '--seq', '1', '--output-file', join(home, 'x.json')]);
        strictEqual(r.code, 0);
    });
});
