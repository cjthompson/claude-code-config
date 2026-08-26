/*  Run the tests:
 *    node --experimental-strip-types --test plugins/project-tasks/task-db.plan-read.test.mts
 *
 *  The three read-only plan reporting commands — `plan tasks`, `plan status`,
 *  and `plan progress` — against the real binary, a real sqlite3, and a real
 *  temp database. Nothing here is a unit test of a string builder: every
 *  assertion below is on output a caller actually receives, because the failure
 *  modes these commands have are all about which ROWS are selected and how they
 *  are joined, not about how a line is formatted.
 *
 *  The recurring theme is that a plan is GLOBAL. It may own tasks in several
 *  repositories, so `--project` names the plan's owner and never filters its
 *  children; two children can share a `#NNN`; and a child's dependencies resolve
 *  in its own project, not the plan owner's. Each of those has a test that fails
 *  if the join is written the obvious, wrong way.
 *
 *  Every test gets its own PROJECT_TASKS_HOME. Nothing here reads or writes
 *  ~/.claude/tasks.db.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, 'bin', 'task-db');

type Result = { code: number; out: string; err: string };

/** A fresh, isolated PROJECT_TASKS_HOME. */
function newHome(): string {
    return mkdtempSync(join(tmpdir(), 'task-db-pr-'));
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

/**
 * Create a plan through the real `plan create` (so it carries its `created`
 * auto-note) and return its GLOBAL numeric id — the value `--plan-id` takes.
 */
function makePlan(home: string, project: string, title: string, body?: string): number {
    const args = ['plan', 'create', '--project', project, '--title', title];
    if (body !== undefined) {
        const file = join(home, `${title.replace(/\W+/g, '-')}.md`);
        writeFileSync(file, body);
        args.push('--content-file', file);
    }
    const r = run(home, args);
    strictEqual(r.code, 0, r.err);
    const seq = Number(r.out.slice(1));
    return Number(query(home, `SELECT id FROM plans WHERE project='${project}' AND seq=${seq};`));
}

/** Add one child task to a plan and return its project-local `seq`. */
function addChild(
    home: string,
    project: string,
    planId: number,
    title: string,
    anchor: string,
    extra: string[] = [],
): number {
    const r = run(home, [
        'task', 'add', '--project', project, '--type', 'task', '--title', title,
        '--plan-id', String(planId), '--anchor', anchor, ...extra,
    ]);
    strictEqual(r.code, 0, r.err);
    return Number(r.out.slice(1));
}

const SPREAD_BODY = `# Auth rewrite

Intro paragraph.

## Step one

Prose one.

## Step two

Prose two.

## Step three

Prose three.

## Step four

Prose four.
`;

/**
 * One plan owned by `testproj` with four children, one in each status. Every
 * command has to handle all four, and a fixture that only exercises two hides
 * an off-by-one in the tally.
 */
function spreadPlan(home: string): number {
    const planId = makePlan(home, 'testproj', 'Auth rewrite', SPREAD_BODY);
    addChild(home, 'testproj', planId, 'One', 'step-one');
    addChild(home, 'testproj', planId, 'Two', 'step-two');
    addChild(home, 'testproj', planId, 'Three', 'step-three');
    addChild(home, 'testproj', planId, 'Four', 'step-four');
    run(home, ['task', 'update', '--project', 'testproj', '--seq', '2', '--status', 'in_progress']);
    run(home, [
        'task', 'update', '--project', 'testproj', '--seq', '3', '--status', 'completed',
        '--completed-at', '2026-08-09 12:00', '--commit-sha', 'deadbeef',
    ]);
    run(home, ['task', 'update', '--project', 'testproj', '--seq', '4', '--status', 'cancelled']);
    return planId;
}

/**
 * One plan owned by `testproj` owning a task in `testproj` and a task in
 * `frontend`. Both children are `#001` in their own project — which is the
 * whole reason the `project` column exists.
 */
function crossProjectPlan(home: string): number {
    const planId = makePlan(home, 'testproj', 'Coordinated work', '# Coordinated work\n\n## Backend step\n\n## Frontend step\n');
    addChild(home, 'testproj', planId, 'Backend work', 'backend-step');
    addChild(home, 'frontend', planId, 'Frontend work', 'frontend-step');
    return planId;
}

// ── plan tasks ────────────────────────────────────────────────

describe('plan tasks', () => {
    it('emits #NNN|project|anchor|type|title|priority|status in that order', () => {
        const home = initialized();
        spreadPlan(home);
        const rows = run(home, ['plan', 'tasks', '--project', 'testproj', '--seq', '1']).out.split('\n');
        deepStrictEqual(rows[0].split('|'), [
            '#001', 'testproj', 'step-one', 'task', 'One', 'medium', 'pending',
        ]);
        strictEqual(rows.length, 4);
    });

    it('returns children in every status, including cancelled, with no default filter', () => {
        // `task list` hides cancelled by default. Copying that here would break
        // both callers: the reconciliation loop classifies every existing
        // anchor, and the post-cancel check reads this command to confirm a
        // cascade skipped the completed child.
        const home = initialized();
        spreadPlan(home);
        const statuses = run(home, ['plan', 'tasks', '--project', 'testproj', '--seq', '1']).out
            .split('\n')
            .map((line) => line.split('|')[6]);
        deepStrictEqual(statuses, ['pending', 'in_progress', 'completed', 'cancelled']);
    });

    it('--status filters exactly, with no implicit second predicate', () => {
        const home = initialized();
        spreadPlan(home);
        const r = run(home, ['plan', 'tasks', '--project', 'testproj', '--seq', '1', '--status', 'cancelled']);
        strictEqual(r.code, 0);
        deepStrictEqual(r.out.split('\n').map((line) => line.split('|')[0]), ['#004']);
    });

    it('returns every child regardless of repository, distinguished by the project column', () => {
        const home = initialized();
        crossProjectPlan(home);
        const rows = run(home, ['plan', 'tasks', '--project', 'testproj', '--seq', '1']).out.split('\n');
        strictEqual(rows.length, 2, 'both children must come back, not just the owner project’s');
        deepStrictEqual(rows.map((line) => line.split('|')[0]), ['#001', '#001']);
        deepStrictEqual(rows.map((line) => line.split('|')[1]), ['testproj', 'frontend']);
    });

    it('--project identifies the plan owner, so the child’s project does not find the plan', () => {
        const home = initialized();
        crossProjectPlan(home);
        const r = run(home, ['plan', 'tasks', '--project', 'frontend', '--seq', '1']);
        notStrictEqual(r.code, 0);
        match(r.err, /no plan P001/);
    });

    it('orders by insertion, not by seq, so two repositories do not interleave', () => {
        // Ordering by `seq` looks right until a plan spans projects, where the
        // numbering is per-project and sorting by it produces a step order that
        // belongs to neither document.
        const home = initialized();
        const planId = makePlan(home, 'testproj', 'Spanning', '# S\n');
        addChild(home, 'frontend', planId, 'F1', 'f1');
        addChild(home, 'testproj', planId, 'B1', 'b1');
        addChild(home, 'frontend', planId, 'F2', 'f2');
        deepStrictEqual(
            run(home, ['plan', 'tasks', '--project', 'testproj', '--seq', '1']).out
                .split('\n')
                .map((line) => line.split('|')[2]),
            ['f1', 'b1', 'f2'],
        );
    });

    it('succeeds with empty output for a plan that owns no tasks', () => {
        const home = initialized();
        makePlan(home, 'testproj', 'Empty');
        const r = run(home, ['plan', 'tasks', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0);
        strictEqual(r.out, '');
    });

    it('fails naming the P### when the plan does not exist', () => {
        const home = initialized();
        const r = run(home, ['plan', 'tasks', '--project', 'testproj', '--seq', '99']);
        notStrictEqual(r.code, 0);
        match(r.err, /no plan P099/);
        strictEqual(r.out, '');
    });
});

// ── plan status ───────────────────────────────────────────────

describe('plan status', () => {
    it('reproduces the body verbatim and inserts the annotation under the matching heading', () => {
        const home = initialized();
        spreadPlan(home);
        const out = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']).out;
        const body = out.split('## History')[0].trimEnd();
        deepStrictEqual(body.split('\n'), [
            '# Auth rewrite',
            '',
            'Intro paragraph.',
            '',
            '## Step one',
            '> **#001** · pending · testproj',
            '',
            'Prose one.',
            '',
            '## Step two',
            '> **#002** · in_progress · testproj',
            '',
            'Prose two.',
            '',
            '## Step three',
            '> **#003** · completed · testproj · 2026-08-09 12:00 · deadbeef',
            '',
            'Prose three.',
            '',
            '## Step four',
            '> **#004** · cancelled · testproj',
            '',
            'Prose four.',
        ]);
    });

    it('renders a note under the step it names and leaves unattributed notes to the footer', () => {
        const home = initialized();
        spreadPlan(home);
        run(home, [
            'plan', 'note', 'add', '--project', 'testproj', '--seq', '1',
            '--note', 'rescoped after review', '--task', 'testproj#002',
        ]);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'general remark']);

        const lines = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']).out.split('\n');
        const stepTwo = lines.indexOf('## Step two');
        match(lines[stepTwo + 1], /^> \*\*#002\*\* · in_progress/);
        match(lines[stepTwo + 2], /^> _.+_ · manual — rescoped after review$/);

        const history = lines.slice(lines.indexOf('## History'));
        ok(history.some((line) => line.includes('general remark')), 'unattributed note belongs in History');
        ok(
            !history.some((line) => line.includes('rescoped after review')),
            'an attributed note must not be repeated in History',
        );
    });

    it('keeps a note whose task refs match nothing rendered, rather than dropping it', () => {
        // The tempting implementation partitions on "does the note carry refs".
        // A note naming a task that is not a child of this plan then belongs to
        // neither bucket and disappears from the audit trail entirely.
        const home = initialized();
        spreadPlan(home);
        run(home, [
            'plan', 'note', 'add', '--project', 'testproj', '--seq', '1',
            '--note', 'refers to a stranger', '--task', 'testproj#099',
        ]);
        const out = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']).out;
        const history = out.slice(out.indexOf('## History'));
        match(history, /refers to a stranger/);
        match(history, /\(testproj#099\)/);
    });

    it('annotates both repositories’ children, naming the project on each line', () => {
        const home = initialized();
        crossProjectPlan(home);
        const lines = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']).out.split('\n');
        strictEqual(lines[lines.indexOf('## Backend step') + 1], '> **#001** · pending · testproj');
        strictEqual(lines[lines.indexOf('## Frontend step') + 1], '> **#001** · pending · frontend');
    });

    it('attaches a qualified note only to the named project child', () => {
        const home = initialized();
        crossProjectPlan(home);
        run(home, [
            'plan', 'note', 'add', '--project', 'testproj', '--seq', '1',
            '--note', 'backend-only', '--task', 'testproj#001',
        ]);
        const lines = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']).out.split('\n');
        const backend = lines.indexOf('## Backend step');
        const frontend = lines.indexOf('## Frontend step');
        match(lines[backend + 2], /^> _.+_ · manual — backend-only$/);
        ok(lines.slice(frontend, frontend + 3).every((line) => !line.includes('backend-only')));
        ok(!lines.slice(lines.indexOf('## History')).some((line) => line.includes('backend-only')));
    });

    it('resolves a legacy integer only to the plan owner and does not rewrite storage', () => {
        const home = initialized();
        const planId = crossProjectPlan(home);
        exec(
            home,
            `UPDATE plans SET notes=json_insert(COALESCE(notes,'[]'),'$[#]',json('{"id":99,"ts":"2026-08-16 12:00","kind":"manual","tasks":[1],"note":"legacy owner ref"}')) WHERE id=${planId};`,
        );
        const before = query(home, `SELECT notes FROM plans WHERE id=${planId};`);
        const lines = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']).out.split('\n');
        const backend = lines.indexOf('## Backend step');
        const frontend = lines.indexOf('## Frontend step');
        ok(lines.slice(backend, backend + 3).some((line) => line.includes('legacy owner ref')));
        ok(lines.slice(frontend, frontend + 3).every((line) => !line.includes('legacy owner ref')));
        strictEqual(query(home, `SELECT notes FROM plans WHERE id=${planId};`), before);
        strictEqual(query(home, `SELECT json_extract(value,'$.tasks[0]') FROM plans, json_each(plans.notes) WHERE plans.id=${planId} AND json_extract(value,'$.id')=99;`), '1');
    });

    it('prints the body and warns on stderr when no heading matches any anchor', () => {
        const home = initialized();
        const planId = makePlan(home, 'testproj', 'Renamed', '# Renamed\n\n## Totally different heading\n\nProse.\n');
        addChild(home, 'testproj', planId, 'Orphan step', 'step-one');

        const r = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0, 'an unmatched anchor is a warning, not a failure');
        match(r.out, /## Totally different heading/);
        ok(!r.out.includes('> **#001**'), 'nothing should be annotated');
        match(r.err, /step-one/);
        ok(!/\|/.test(r.out), 'it must never silently fall back to the table');
    });

    it('warns about the anchors that did not match even when others did', () => {
        const home = initialized();
        const planId = makePlan(home, 'testproj', 'Partial', '# Partial\n\n## Step one\n\nProse.\n');
        addChild(home, 'testproj', planId, 'One', 'step-one');
        addChild(home, 'testproj', planId, 'Gone', 'step-removed');

        const r = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0);
        match(r.out, /> \*\*#001\*\* · pending/);
        match(r.err, /step-removed/);
        ok(!r.err.includes('step-one'), 'a matched anchor must not be reported as unmatched');
    });

    it('--limit bounds the History footer and accounts for the remainder', () => {
        const home = initialized();
        spreadPlan(home);
        for (const text of ['n1', 'n2', 'n3', 'n4']) {
            run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', text]);
        }
        // 4 manual notes + the `created` auto-note = 5 unattributed.
        const full = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']).out;
        strictEqual(full.split('## History')[1].split('\n').filter((l) => l.startsWith('- ')).length, 5);
        ok(!full.includes('earlier note'), 'the default limit of 10 covers all five');

        const limited = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1', '--limit', '2']).out;
        const shown = limited.split('## History')[1].split('\n').filter((l) => l.startsWith('- '));
        strictEqual(shown.length, 2);
        match(shown[0], /n4/);
        match(limited, /\(3 earlier notes\)/);
    });

    it('preserves an empty body without synthetic content', () => {
        const home = initialized();
        makePlan(home, 'testproj', 'Empty');
        const r = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0);
        strictEqual(r.err, '', 'there are no anchors, so there is nothing to warn about');
        ok(!r.out.includes('_(this plan has no content)_'));
        match(r.out, /## History/);
        match(r.out, /Plan created\./);

        const target = join(home, 'nested', 'empty-status.md');
        const fileResult = run(home, [
            'plan', 'status', '--project', 'testproj', '--seq', '1', '--output-file', target,
        ]);
        strictEqual(fileResult.code, 0);
        const written = readFileSync(target, 'utf-8');
        ok(!written.includes('_(this plan has no content)_'));
        strictEqual(written, `${r.out}\n`);
        strictEqual(fileResult.out, `${Buffer.byteLength(written)} bytes → ${target}`);
    });

    it('writes the payload to --output-file with only a confirmation on stdout', () => {
        const home = initialized();
        spreadPlan(home);
        const target = join(home, 'nested', 'status.md');
        const r = run(home, [
            'plan', 'status', '--project', 'testproj', '--seq', '1', '--output-file', target,
        ]);
        strictEqual(r.code, 0);
        ok(existsSync(target), 'parent directories should be created');
        const written = readFileSync(target, 'utf-8');
        match(written, /^# Auth rewrite\n/);
        match(written, /> \*\*#003\*\* · completed/);
        strictEqual(r.out, `${Buffer.byteLength(written)} bytes → ${target}`);
        ok(!r.out.includes('Auth rewrite'), 'the payload must not also go to stdout');
    });

    it('fails naming the P### when the plan does not exist', () => {
        const home = initialized();
        const r = run(home, ['plan', 'status', '--project', 'testproj', '--seq', '7']);
        notStrictEqual(r.code, 0);
        match(r.err, /no plan P007/);
        strictEqual(r.out, '');
    });
});

// ── plan progress ─────────────────────────────────────────────

describe('plan progress', () => {
    it('renders a header, a six-column table and a summary that agrees with the rows', () => {
        const home = initialized();
        spreadPlan(home);
        const out = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1']).out;

        match(out, /^# P001 · Auth rewrite$/m);
        match(out, /^inline · drift n\/a · 1\/4 complete$/m);
        deepStrictEqual(
            out.split('\n').find((line) => line.startsWith('| ID '))?.split('|').map((c) => c.trim()),
            ['', 'ID', 'Project', 'Step', 'Status', 'When', 'Commit', ''],
        );
        match(out, /^\| #003 \| testproj \| step-three \| completed \| 2026-08-09 12:00 \| deadbeef \|$/m);
        match(out, /P001 has 4 tasks: 1 completed, 1 in progress, 1 pending, 1 cancelled\./);
        match(out, /2 tasks remain open\./);
    });

    it('names every child project in the table so duplicate #NNN are unambiguous', () => {
        const home = initialized();
        crossProjectPlan(home);
        const rows = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1']).out
            .split('\n')
            .filter((line) => line.startsWith('| #'));
        strictEqual(rows.length, 2);
        deepStrictEqual(
            rows.map((line) => line.split('|').slice(1, 3).map((c) => c.trim())),
            [['#001', 'testproj'], ['#001', 'frontend']],
        );
    });

    it('--counts emits total|pending|in_progress|completed|cancelled|blocked and nothing else', () => {
        const home = initialized();
        spreadPlan(home);
        const r = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1', '--counts']);
        strictEqual(r.code, 0);
        const fields = r.out.split('|');
        strictEqual(fields.length, 6);
        strictEqual(fields[0], '4', 'field 1 is total');
        strictEqual(fields[1], '1', 'field 2 is pending');
        strictEqual(fields[2], '1', 'field 3 is in_progress');
        strictEqual(fields[3], '1', 'field 4 is completed');
        strictEqual(fields[4], '1', 'field 5 is cancelled');
        strictEqual(fields[5], '0', 'field 6 is blocked');
        ok(!r.out.includes('\n'), '--counts replaces the whole report with one line');
    });

    it('counts a pending task with an incomplete dependency as blocked', () => {
        const home = initialized();
        const planId = makePlan(home, 'testproj', 'Deps', '# Deps\n');
        addChild(home, 'testproj', planId, 'First', 'first');
        addChild(home, 'testproj', planId, 'Second', 'second', ['--dep', '1']);

        strictEqual(
            run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1', '--counts']).out,
            '2|2|0|0|0|1',
        );
        run(home, ['task', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed']);
        strictEqual(
            run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1', '--counts']).out,
            '2|1|0|1|0|0',
        );
    });

    it('resolves a child’s dependencies in the child’s project, not the plan owner’s', () => {
        // `depends_on` holds project-local seq values. Joining them against the
        // plan owner's project reads the wrong rows entirely: here the owner's
        // #001 is completed while the frontend #001 the child actually depends
        // on is not, so a wrong join reports `blocked` as 0.
        const home = initialized();
        const planId = makePlan(home, 'testproj', 'Cross deps', '# Cross deps\n');
        addChild(home, 'testproj', planId, 'Owner first', 'owner-first');
        run(home, ['task', 'update', '--project', 'testproj', '--seq', '1', '--status', 'completed']);
        addChild(home, 'frontend', planId, 'Frontend first', 'frontend-first');
        addChild(home, 'frontend', planId, 'Frontend second', 'frontend-second', ['--dep', '1']);

        strictEqual(
            run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1', '--counts']).out.split('|')[5],
            '1',
        );
    });

    it('reports a plan with no tasks as 0/0 with no percentage and no NaN', () => {
        const home = initialized();
        makePlan(home, 'testproj', 'Empty');
        const r = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1']);
        strictEqual(r.code, 0);
        match(r.out, /0\/0 complete/);
        match(r.out, /has no tasks yet/);
        ok(!/NaN|Infinity|%/.test(r.out), 'an empty plan must not divide by zero');
        strictEqual(
            run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1', '--counts']).out,
            '0|0|0|0|0|0',
        );
    });

    it('reports drift for a linked plan whose file changed', () => {
        const home = initialized();
        const file = join(home, 'linked.md');
        writeFileSync(file, '# Linked\n');
        run(home, ['plan', 'create', '--project', 'testproj', '--title', 'Linked', '--path', file]);
        match(run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1']).out, /linked · drift clean/);
        writeFileSync(file, '# Linked\n\n## New step\n');
        match(run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1']).out, /linked · drift drifted/);
    });

    it('shows the newest note, and says so plainly when there are none', () => {
        const home = initialized();
        spreadPlan(home);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'older']);
        run(home, ['plan', 'note', 'add', '--project', 'testproj', '--seq', '1', '--note', 'newest']);
        const out = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '1']).out;
        match(out, /\*\*Latest note\*\* — _.+_ · manual — newest/);
        ok(!out.includes('older'), 'only the latest note belongs in the report');

        // A directly-seeded plan has never been through `plan create`, so its
        // notes array is empty — the case a `notes[0]` deref would crash on.
        seedPlan(home, 'testproj', 2);
        const bare = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '2']);
        strictEqual(bare.code, 0);
        match(bare.out, /No notes yet/);
    });

    it('writes the payload to --output-file with only a confirmation on stdout', () => {
        const home = initialized();
        spreadPlan(home);
        const target = join(home, 'progress.md');
        const r = run(home, [
            'plan', 'progress', '--project', 'testproj', '--seq', '1', '--output-file', target,
        ]);
        strictEqual(r.code, 0);
        const written = readFileSync(target, 'utf-8');
        match(written, /^# P001 · Auth rewrite\n/);
        strictEqual(r.out, `${Buffer.byteLength(written)} bytes → ${target}`);
    });

    it('--counts survives --output-file with its exit code and field order intact', () => {
        const home = initialized();
        spreadPlan(home);
        const target = join(home, 'counts.txt');
        const r = run(home, [
            'plan', 'progress', '--project', 'testproj', '--seq', '1', '--counts', '--output-file', target,
        ]);
        strictEqual(r.code, 0);
        strictEqual(readFileSync(target, 'utf-8'), '4|1|1|1|1|0\n');
    });

    it('fails naming the P### when the plan does not exist', () => {
        const home = initialized();
        const r = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '42']);
        notStrictEqual(r.code, 0);
        match(r.err, /no plan P042/);
        strictEqual(r.out, '');

        const counts = run(home, ['plan', 'progress', '--project', 'testproj', '--seq', '42', '--counts']);
        notStrictEqual(counts.code, 0);
        match(counts.err, /no plan P042/);
        strictEqual(counts.out, '', 'a missing plan must not report zero counts as success');
    });
});
