/**
 * handlers — one function per command in `registry.mjs`, keyed by its `handler`
 * name so `bin/task-db` dispatches by table lookup rather than by `switch`.
 *
 * The contract with the parser is fixed and worth stating once, because it is
 * what keeps these functions short:
 *
 *     the parser validated flag SHAPE; a handler validates against STATE.
 *
 * By the time a handler runs, `--seq` is a number, `--status` is a member of its
 * enum, `--anchor` is a non-empty slug, and `--project` is normalized. Nothing
 * here re-checks any of that. What a handler owns is everything the parser
 * cannot see: rows, files, hashes, and constraints.
 *
 * A handler returns its exit code (or nothing, meaning 0) and never calls
 * `process.exit` — so stdout is always flushed before the process ends.
 *
 * Scope note: this file owns the `db *` and `task *` commands, plus `plan
 * create`, `plan get`, `plan list`, and the four `plan note *` commands. The
 * remaining `plan *` commands live in two sibling modules — `plan-read.mjs`
 * (the reporting commands) and `plan-sync.mjs` (the reconciliation loop) —
 * which are merged into `HANDLERS` below. Every plan command in the registry
 * has a handler; there is no stub fallback. The integration suite asserts the
 * handler set covers the registry, so a missing one fails the build rather
 * than dispatching to `undefined`.
 */

import { COMMANDS, ENUMS } from './registry.mjs';
import { normalizeProject } from './normalize.mjs';
import { PLAN_READ_HANDLERS } from './plan-read.mjs';
import { PLAN_SYNC_HANDLERS } from './plan-sync.mjs';
import { ADDITIVE_TASK_COLUMNS, CREATE_INDEXES, CREATE_PLANS, CREATE_TASKS } from './schema.mjs';
import {
    addNote, DbError, emit, esc, findNote, noteDeleteSql, noteInsertSql, noteReplaceSql,
    notesJson, now, planDrift, resolvePlanId, sourceSnapshot,
    sql, sqlBody, sqlJson, sqlRows, tableColumns, transaction,
} from './db.mjs';

// ── db ────────────────────────────────────────────────────────

/**
 * Create anything missing and add anything new, without ever rebuilding a table.
 *
 * Exits 2 on a first-time setup — the caller's signal that this is a new
 * database rather than an upgraded one. That code predates this rewrite and is
 * preserved deliberately.
 *
 * @returns {number}
 */
function dbInit() {
    const firstTime = sql("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks';") === '';

    // `plans` first: the `tasks.plan_id` ALTER below names it in a REFERENCES
    // clause, which is checked at ALTER time.
    transaction([CREATE_TASKS, CREATE_PLANS]);

    const existing = tableColumns('tasks');
    const additions = ADDITIVE_TASK_COLUMNS.filter(([name]) => !existing.has(name)).map(([, ddl]) => ddl);

    // The index creation is unconditional (IF NOT EXISTS) so a database that
    // already has the columns from a partial run still ends up with it.
    transaction([...additions, ...CREATE_INDEXES]);

    return firstTime ? 2 : 0;
}

/**
 * Rewrite legacy/duplicate project identifiers to their normalized form.
 *
 * The renumbering and the rename for one project are a single batch: halfway
 * through, source rows carry destination sequence numbers but the old project
 * name, which satisfies no invariant anyone would want to debug.
 *
 * @param {any} action
 */
function dbMigrate(action) {
    const distinct = sql('SELECT DISTINCT project FROM tasks;');
    const names = distinct ? distinct.split('\n').filter(Boolean) : [];

    /** @type {Map<string,string>} old → new, only where they differ */
    const renames = new Map();
    for (const oldName of names) {
        const newName = normalizeProject(oldName);
        if (newName !== oldName) renames.set(oldName, newName);
    }

    if (renames.size === 0) {
        emit('No project names needed migration.', action.global.outputFile);
        return 0;
    }

    const report = [];
    let totalMoved = 0;
    for (const [oldName, newName] of renames) {
        // seq restarts above the destination's maximum, so UNIQUE(project,seq)
        // cannot trip when the same real project was logged under two names
        // with overlapping sequences.
        const maxNew =
            Number(sql(`SELECT COALESCE(MAX(seq), 0) FROM tasks WHERE project='${esc(newName)}';`)) || 0;
        const rows = sqlJson(`SELECT id, seq FROM tasks WHERE project='${esc(oldName)}' ORDER BY id;`);
        if (rows.length === 0) continue;

        // Park the source sequences negative before assigning the final ones.
        // Without this the renumbering collides with ITSELF: moving seq 1→2 in a
        // project that still holds a row at seq 2 trips UNIQUE(project,seq)
        // mid-loop. seq is always ≥ 1, so the negative space is free, and the
        // whole park-assign-rename sequence commits as one batch.
        const statements = [`UPDATE tasks SET seq=-seq WHERE project='${esc(oldName)}';`];
        rows.forEach(({ id }, i) => {
            statements.push(`UPDATE tasks SET seq=${maxNew + 1 + i} WHERE id=${Number(id)};`);
        });
        statements.push(`UPDATE tasks SET project='${esc(newName)}' WHERE project='${esc(oldName)}';`);
        transaction(statements);

        report.push(`${oldName} -> ${newName}  (${rows.length} row${rows.length === 1 ? '' : 's'})`);
        totalMoved += rows.length;
    }
    report.push(
        `Migrated ${totalMoved} row${totalMoved === 1 ? '' : 's'} across ` +
            `${renames.size} project${renames.size === 1 ? '' : 's'}.`,
    );
    emit(report.join('\n'), action.global.outputFile);
    return 0;
}

// ── task ──────────────────────────────────────────────────────

/**
 * Build the `plan_id` / `plan_anchor` / `commit_sha` column-value pairs shared
 * by `task add` and `task update`.
 *
 * @param {any} opts
 * @returns {Array<[string,string]>}
 */
function planColumns(opts) {
    /** @type {Array<[string,string]>} */
    const pairs = [];
    if (opts.planId !== undefined) pairs.push(['plan_id', String(Number(opts.planId))]);
    if (opts.anchor !== undefined) pairs.push(['plan_anchor', `'${esc(opts.anchor)}'`]);
    if (opts.commitSha !== undefined) pairs.push(['commit_sha', `'${esc(opts.commitSha)}'`]);
    return pairs;
}

/**
 * Insert a task and print its `#NNN`.
 *
 * With `--anchor` the insert is `ON CONFLICT DO NOTHING` and the id comes from a
 * select on `(plan_id, plan_anchor)` rather than `last_insert_rowid()`. That is
 * what makes `create-tasks` re-runnable: the second call for the same plan step
 * inserts nothing and reports the id that already exists, instead of either
 * failing or creating a duplicate task for the same step.
 *
 * Without `--anchor` the insert stays plain, so a genuine constraint failure is
 * still an error rather than a silent no-op.
 *
 * @param {any} action
 */
function taskAdd(action) {
    const o = action.opts;
    const p = esc(action.global.project);

    const columns = ['project', 'seq', 'type', 'title', 'priority', 'tags', 'reqs', 'depends_on', 'created'];
    const values = [
        `'${p}'`,
        `(SELECT COALESCE(MAX(seq),0)+1 FROM tasks WHERE project='${p}')`,
        `'${esc(o.type)}'`,
        `'${esc(o.title)}'`,
        `'${esc(o.priority)}'`,
        `'${esc(JSON.stringify(o.tags ?? []))}'`,
        `'${esc(JSON.stringify(o.reqs ?? []))}'`,
        `'${esc(JSON.stringify(o.deps ?? []))}'`,
        `'${esc(o.created ?? now())}'`,
    ];
    for (const [column, value] of planColumns(o)) {
        columns.push(column);
        values.push(value);
    }

    if (o.anchor !== undefined) {
        transaction([
            `INSERT INTO tasks(${columns.join(',')}) VALUES(${values.join(',')}) ON CONFLICT DO NOTHING;`,
        ]);
        const seq = sql(
            `SELECT printf('#%03d',seq) FROM tasks
              WHERE plan_id=${Number(o.planId)} AND plan_anchor='${esc(o.anchor)}';`,
        );
        if (seq === '') {
            throw new DbError(
                `ERROR: the task for anchor '${o.anchor}' was neither inserted nor found.\n` +
                    `       Plan ${o.planId} may not exist, or the row belongs to a different plan.`,
            );
        }
        emit(seq, action.global.outputFile);
        return 0;
    }

    const result = transaction([
        `INSERT INTO tasks(${columns.join(',')}) VALUES(${values.join(',')});`,
        "SELECT printf('#%03d',seq) FROM tasks WHERE id=last_insert_rowid();",
    ]);
    emit(result, action.global.outputFile);
    return 0;
}

/**
 * The trailing plan column shared by `task list` and `task changelog list`.
 *
 * Empty for a task belonging to no plan, `P003` for one whose plan lives in the
 * same project, and `P003 (other/project)` when it does not. That last case is
 * not decoration: `plans.seq` is project-local, so a bare `P003` on a task in
 * one repository can name a completely different plan than `P003` does in
 * another. A reader who acts on the unqualified label — running
 * `plan progress --seq 3` against their own project — gets a real plan that is
 * the wrong one, with no error to warn them.
 *
 * Defined once because the two commands must agree; a reader comparing a task
 * list against a changelog cannot be expected to notice that one of them
 * qualifies cross-project plans and the other does not.
 *
 * Assumes the task is aliased `t` and the LEFT JOIN on plans is aliased `pl`.
 */
const PLAN_LABEL = `CASE
        WHEN pl.id IS NULL THEN ''
        WHEN pl.project = t.project THEN printf('P%03d', pl.seq)
        ELSE printf('P%03d (%s)', pl.seq, pl.project)
    END`;

/**
 * Update one task. `atLeastOne` in the registry already guaranteed there is a
 * real mutation, so this never writes a bare timestamp.
 *
 * @param {any} action
 */
function taskUpdate(action) {
    const o = action.opts;
    const p = esc(action.global.project);

    /** @type {string[]} */
    const sets = [];
    /** @type {Array<[string, string]>} flag key → column */
    const scalars = [
        ['status', 'status'],
        ['priority', 'priority'],
        ['type', 'type'],
        ['title', 'title'],
        ['created', 'created'],
        ['completedAt', 'completed_at'],
        ['feedback', 'feedback'],
    ];
    for (const [key, column] of scalars) {
        if (o[key] !== undefined) sets.push(`${column}='${esc(o[key])}'`);
    }
    for (const [column, value] of planColumns(o)) sets.push(`${column}=${value}`);

    // The registry's exclusive rule guarantees o.planId/o.anchor are undefined
    // whenever o.clearPlan is true, so this never collides with planColumns() above.
    if (o.clearPlan) sets.push('plan_id=NULL', 'plan_anchor=NULL');

    if (o.tags !== undefined) sets.push(`tags='${esc(JSON.stringify(o.tags))}'`);
    if (o.reqs !== undefined) sets.push(`reqs='${esc(JSON.stringify(o.reqs))}'`);
    if (o.deps !== undefined) sets.push(`depends_on='${esc(JSON.stringify(o.deps))}'`);

    // `completed_at` exists as a column that nothing ever wrote, which is why
    // the changelog has always fallen back to `updated`. COALESCE keeps an
    // explicit `--completed-at` (and any earlier completion) authoritative, so
    // re-completing a task never rewrites when it was first finished.
    if (o.status === 'completed' && o.completedAt === undefined) {
        sets.push(`completed_at=COALESCE(completed_at,'${esc(now())}')`);
    }

    const ts = esc(o.updated ?? now());
    sets.push(`updated='${ts}'`);

    /** @type {string[]} */
    const batch = [
        `UPDATE tasks SET ${sets.join(',')} WHERE project='${p}' AND seq=${Number(o.seq)};`,
    ];

    // Plan auto-advance. Moving a child to `in_progress` promotes its plan
    // `pending → in_progress` in the same invocation, because `references/
    // plans.md` tells the skill never to set a plan's status by hand for this —
    // so if the helper does not do it, nothing does, and a plan sits `pending`
    // while its children run.
    //
    // Guarded three ways, all of them load-bearing:
    //   - `status='pending'` means this only ever promotes. A plan that is
    //     already `in_progress` is untouched, and one that is `completed` or
    //     `cancelled` is never dragged backwards by a late child update.
    //   - The plan id is read from the task row rather than passed in, so a
    //     plan-less task selects nothing and the statement is a no-op. It runs
    //     after the task UPDATE, so an invocation that also moves the task to a
    //     different plan promotes the plan it now belongs to.
    //   - It rides in the same transaction: a task cannot end up `in_progress`
    //     under a plan that failed to advance.
    if (o.status === 'in_progress') {
        batch.push(
            `UPDATE plans SET status='in_progress', updated='${ts}'
              WHERE id=(SELECT plan_id FROM tasks WHERE project='${p}' AND seq=${Number(o.seq)})
                AND status='pending';`,
        );
    }

    transaction(batch);
    return 0;
}

/**
 * One task as JSON, with its plan resolved in the same query.
 *
 * Both id spaces are returned deliberately. `plan_id` is the global numeric id
 * that `--plan-id` consumes; `plan_seq` is the project-local `P###` that every
 * `plan *` subcommand's `--seq` expects. A caller holding only one of them has
 * to make a second query to get the other, and the plan surface is exactly where
 * confusing the two is most likely.
 *
 * `plan_project` is not redundant with the task's own project: a plan is global
 * and may own tasks in other repositories, so a task's plan can carry a `P###`
 * that means nothing in the task's own project. LEFT JOIN, because plan-less
 * tasks are the common case and must still come back — with the three plan
 * fields null.
 *
 * @param {any} action
 */
function taskGet(action) {
    const p = esc(action.global.project);
    const result = sql(
        `SELECT t.seq, t.type, t.title, t.priority, t.tags, t.reqs, t.depends_on, t.status,
                t.plan_id,
                CASE WHEN p.id IS NULL THEN NULL ELSE printf('P%03d', p.seq) END AS plan_seq,
                p.project AS plan_project
           FROM tasks t
           LEFT JOIN plans p ON p.id = t.plan_id
          WHERE t.project='${p}' AND t.seq=${Number(action.opts.seq)};`,
        ['-json'],
    );
    emit(result, action.global.outputFile);
    return 0;
}

/** @param {any} action */
function taskList(action) {
    const p = esc(action.global.project);
    const status = action.opts.status;
    const where = status ? `AND t.status='${esc(status)}'` : "AND t.status!='cancelled'";
    emit(
        sqlRows(
            `SELECT printf('#%03d',t.seq),t.type,t.title,t.priority,t.status,t.tags,t.depends_on,
                    ${PLAN_LABEL}
               FROM tasks t
               LEFT JOIN plans pl ON pl.id = t.plan_id
              WHERE t.project='${p}' ${where}
              ORDER BY t.seq DESC;`,
        ),
        action.global.outputFile,
    );
    return 0;
}

/** @param {any} action */
function taskRecent(action) {
    const p = esc(action.global.project);
    emit(
        sqlRows(
            `SELECT printf('#%03d',seq),type,title,status FROM tasks
              WHERE project='${p}' ORDER BY seq DESC LIMIT ${Number(action.opts.limit)};`,
        ),
        action.global.outputFile,
    );
    return 0;
}

/**
 * Incomplete dependencies of one task, as `#NNN|title|status`.
 * @param {any} action
 */
function taskDepsCheck(action) {
    const p = esc(action.global.project);
    emit(
        sqlRows(
            `SELECT printf('#%03d',seq),title,status FROM tasks
              WHERE project='${p}'
                AND seq IN (
                    SELECT j.value FROM tasks t, json_each(t.depends_on) j
                     WHERE t.project='${p}' AND t.seq=${Number(action.opts.seq)}
                )
                AND status!='completed';`,
        ),
        action.global.outputFile,
    );
    return 0;
}

/**
 * Dependency sequence numbers that do not exist in the project.
 * @param {any} action
 */
function taskDepsValidate(action) {
    const p = esc(action.global.project);
    const deps = esc(JSON.stringify(action.opts.deps));
    emit(
        sql(
            `SELECT j.value FROM json_each('${deps}') j
              WHERE j.value NOT IN (SELECT seq FROM tasks WHERE project='${p}');`,
        ),
        action.global.outputFile,
    );
    return 0;
}

/**
 * Sequence numbers of pending tasks with incomplete dependencies.
 *
 * The outer table is aliased `t` and `depends_on` is qualified with it. That is
 * a bug fix carried over from the flat implementation, not a style change: the
 * subquery joins `tasks d`, so an UNQUALIFIED `depends_on` inside it binds to
 * `d`, not to the row being filtered. `json_each(d.depends_on)` is empty for
 * every dependency-free row, the EXISTS never matched, and `blocked` returned
 * nothing at all — a silent always-empty answer rather than a visible failure.
 *
 * @param {any} action
 */
function taskDepsBlocked(action) {
    const p = esc(action.global.project);
    emit(
        sql(
            `SELECT t.seq FROM tasks t
              WHERE t.project='${p}' AND t.status='pending' AND t.depends_on!='[]'
                AND EXISTS (
                    SELECT 1 FROM json_each(t.depends_on) j
                      JOIN tasks d ON d.project='${p}' AND d.seq=j.value
                     WHERE d.status!='completed'
                );`,
        ),
        action.global.outputFile,
    );
    return 0;
}

/**
 * Tasks newly unblocked by completing `--seq`, as `#NNN|title`.
 *
 * Same qualification fix as `blocked`, and here the consequence was worse than
 * an empty answer: the unqualified `depends_on` made the NOT EXISTS clause
 * always true, so every task depending on the completed one was reported as
 * unblocked even when its OTHER dependencies were still open.
 *
 * @param {any} action
 */
function taskDepsUnblocked(action) {
    const p = esc(action.global.project);
    const seq = Number(action.opts.seq);
    emit(
        sqlRows(
            `SELECT printf('#%03d',t.seq),t.title FROM tasks t
              WHERE t.project='${p}' AND t.status='pending' AND t.depends_on!='[]'
                AND EXISTS (SELECT 1 FROM json_each(t.depends_on) j WHERE j.value=${seq})
                AND NOT EXISTS (
                    SELECT 1 FROM json_each(t.depends_on) j
                      JOIN tasks d ON d.project='${p}' AND d.seq=j.value
                     WHERE d.status!='completed'
                );`,
        ),
        action.global.outputFile,
    );
    return 0;
}

/** @param {any} action */
function taskChangelogList(action) {
    const p = esc(action.global.project);
    const filter = action.opts.newOnly ? 'AND t.in_changelog=0' : '';
    emit(
        sqlRows(
            // COALESCE, because `completed_at` is the honest completion date and
            // `updated` is merely the last time the row was touched — a later
            // edit (a tag, a feedback note) would otherwise re-date a task to
            // long after it was finished, and re-sort the changelog with it.
            // Rows written before `completed_at` was populated have none, so
            // `updated` remains the fallback rather than the source.
            `SELECT t.seq,substr(COALESCE(t.completed_at,t.updated),1,10),t.type,t.title,t.tags,
                    ${PLAN_LABEL}
               FROM tasks t
               LEFT JOIN plans pl ON pl.id = t.plan_id
              WHERE t.project='${p}' AND t.status='completed' ${filter}
              ORDER BY COALESCE(t.completed_at,t.updated) DESC;`,
        ),
        action.global.outputFile,
    );
    return 0;
}

/** @param {any} action */
function taskChangelogMark(action) {
    const p = esc(action.global.project);
    if (action.opts.all) {
        transaction([`UPDATE tasks SET in_changelog=1 WHERE project='${p}' AND status='completed';`]);
        return 0;
    }
    const seqs = (action.opts.seqs ?? []).map(Number);
    if (seqs.length === 0) return 0; // unreachable: the registry's atLeastOne covers it
    transaction([`UPDATE tasks SET in_changelog=1 WHERE project='${p}' AND seq IN (${seqs.join(',')});`]);
    return 0;
}

// ── plan ──────────────────────────────────────────────────────

/**
 * Create a plan, seed its content from `--path` (linked) or `--content-file`
 * (inline) — or leave it empty (also inline) — and record the `created`
 * auto-note. Prints `P%03d`.
 *
 * Seq allocation mirrors `taskAdd`: the subquery runs inside the INSERT,
 * inside `transaction()`'s `BEGIN IMMEDIATE`, so the write lock serializes
 * concurrent creators before either MAX(seq) subquery evaluates.
 *
 * The INSERT, the `created` note, and the display-seq SELECT commit as one
 * batch — the new id never round-trips through JavaScript.
 *
 * @param {any} action
 */
function planCreate(action) {
    const o = action.opts;
    const p = esc(action.global.project);

    const source = o.path !== undefined ? 'linked' : 'inline';
    const sourcePath = o.path ?? o.contentFile ?? null;

    let contentExpr = 'NULL';
    let contentHash = null;
    let syncedAt = null;
    let snapshot = null;
    if (sourcePath !== null) {
        snapshot = sourceSnapshot(sourcePath);
        contentHash = snapshot.hash;
        contentExpr = snapshot.expression;
        if (source === 'linked') syncedAt = now();
    }

    const columns = ['project', 'seq', 'title', 'source', 'created', 'content'];
    const values = [
        `'${p}'`,
        `(SELECT COALESCE(MAX(seq),0)+1 FROM plans WHERE project='${p}')`,
        `'${esc(o.title)}'`,
        `'${source}'`,
        `'${esc(now())}'`,
        contentExpr,
    ];
    if (source === 'linked') {
        columns.push('path');
        values.push(`'${esc(o.path)}'`);
    }
    if (o.origin !== undefined) {
        columns.push('origin_path');
        values.push(`'${esc(o.origin)}'`);
    }
    if (contentHash !== null) {
        columns.push('content_hash');
        values.push(`'${esc(contentHash)}'`);
    }
    if (syncedAt !== null) {
        columns.push('synced_at');
        values.push(`'${esc(syncedAt)}'`);
    }
    if (o.tags !== undefined) {
        columns.push('tags');
        values.push(`'${esc(JSON.stringify(o.tags))}'`);
    }

    const insertSql = `INSERT INTO plans(${columns.join(',')}) VALUES(${values.join(',')});`;
    const { sql: noteSql, cleanup } = noteInsertSql('last_insert_rowid()', 'created', {
        note: 'Plan created.',
    });
    try {
        const result = transaction([
            insertSql,
            noteSql,
            "SELECT printf('P%03d',seq) FROM plans WHERE id=last_insert_rowid();",
        ]);
        emit(result, action.global.outputFile);
    } finally {
        cleanup();
        snapshot?.cleanup();
    }
    return 0;
}

/**
 * One plan as JSON (default: metadata only; `--with-content` adds the body),
 * or the raw stored body with `--content-only`.
 *
 * `--content-only` goes through `sqlBody`, not `sql`: `sql()` trims ALL
 * leading/trailing whitespace, which would silently drop a plan body's real
 * trailing newline and break the `--content-only --output-file` round-trip.
 *
 * `drift` is intentionally NOT included here in this slice.
 *
 * @param {any} action
 */
function planGet(action) {
    const p = esc(action.global.project);
    const seq = Number(action.opts.seq);

    if (action.opts.contentOnly) {
        const body = sqlBody(`SELECT content FROM plans WHERE project='${p}' AND seq=${seq};`);
        emit(body, action.global.outputFile, { raw: true });
        return 0;
    }

    const contentColumn = action.opts.withContent ? ', content' : '';
    const result = sql(
        `SELECT id, project, seq, title, source, path, origin_path, content_hash,
                synced_at, pending_hash, pending_at, status, notes, tags, created, updated${contentColumn}
           FROM plans
          WHERE project='${p}' AND seq=${seq};`,
        ['-json'],
    );
    emit(result, action.global.outputFile);
    return 0;
}

/**
 * Every plan as `P%03d|title|source|status|done|total|drift`.
 *
 * `drift` cannot be computed in SQL — it depends on the live filesystem — so
 * this handler fetches rows as JSON, computes drift in JS via `planDrift`,
 * and builds the pipe-separated line itself. It is the one list handler that
 * cannot use `sqlRows`.
 *
 * Hiding cancelled plans by default and `ORDER BY seq DESC` mirror `taskList`.
 *
 * @param {any} action
 */
function planList(action) {
    const p = esc(action.global.project);
    const status = action.opts.status;
    const where = status ? `AND status='${esc(status)}'` : "AND status!='cancelled'";

    const rows = sqlJson(
        `SELECT printf('P%03d',seq) AS display_seq, title, source, status, path, content_hash, pending_hash,
                (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = plans.id AND t.status='completed') AS done,
                (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = plans.id) AS total
           FROM plans
          WHERE project='${p}' ${where}
          ORDER BY seq DESC;`,
    );

    const lines = rows.map((row) => {
        const drift = planDrift({
            source: row.source,
            path: row.path,
            content_hash: row.content_hash,
            pending_hash: row.pending_hash ?? null,
        });
        return `${row.display_seq}|${row.title}|${row.source}|${row.status}|${row.done}|${row.total}|${drift}`;
    });
    emit(lines.join('\n'), action.global.outputFile);
    return 0;
}

// Kinds a caller cannot forge from argv on `add` (the parser already
// restricts `--kind` there to `noteKindWritable`). On the read side, this is
// what the --force guard on replace/delete checks against. Derived from the
// registry rather than duplicated by hand, so a new lifecycle kind added
// there is guarded here automatically.
const LIFECYCLE_NOTE_KINDS = new Set(ENUMS.noteKind.filter((kind) => !ENUMS.noteKindWritable.includes(kind)));

/**
 * Fetch the note a `replace`/`delete` call is targeting, or throw naming the
 * P### and note id that could not be found.
 *
 * @param {number} planId
 * @param {number} seq display seq, for the error message only
 * @param {number} noteId
 * @returns {{id:number, ts:string, kind:string, note?:string, tasks?:Array<{project:string,seq:number}|number>}}
 */
function requireNote(planId, seq, noteId) {
    const note = findNote(planId, noteId);
    if (note === null) {
        throw new DbError(
            `ERROR: no note #${noteId} on P${String(seq).padStart(3, '0')}.\n` +
                `       Run 'plan note list' to see the notes that exist.`,
        );
    }
    return note;
}

/**
 * `--force` is required to replace or delete a note the helper wrote itself
 * (`created`, `applied`, `status`) — those entries are the record of what
 * task-db actually did, not something a caller should casually edit away.
 *
 * @param {{id:number, kind:string}} note
 * @param {boolean|undefined} force
 */
function guardLifecycleNote(note, force) {
    if (LIFECYCLE_NOTE_KINDS.has(note.kind) && !force) {
        throw new DbError(
            `ERROR: note #${note.id} is kind '${note.kind}', written by task-db's own lifecycle hooks.\n` +
                `       Pass --force to replace or delete it.`,
        );
    }
}

/**
 * Append one note to a plan. `--kind` is already restricted to
 * `noteKindWritable` by the parser, so this never re-checks it. Id
 * allocation is `addNote`'s: MAX(id)+1 computed inside the same UPDATE,
 * never round-tripped through JavaScript.
 *
 * @param {any} action
 */
function planNoteAdd(action) {
    const o = action.opts;
    const p = esc(action.global.project);
    const planId = resolvePlanId(p, Number(o.seq));
    addNote(planId, o.kind, { note: o.note, tasks: o.tasks });
    return 0;
}

/**
 * A plan's notes as a JSON array, most-recent-id first, optionally capped to
 * the last `--limit` entries.
 *
 * @param {any} action
 */
function planNoteList(action) {
    const o = action.opts;
    const p = esc(action.global.project);
    const planId = resolvePlanId(p, Number(o.seq));
    emit(notesJson(planId, o.limit ?? null), action.global.outputFile);
    return 0;
}

/**
 * Replace one note's prose and project-qualified task refs, preserving `id`/`ts`/`kind`
 * verbatim and stamping `edited`. A full replace, not a merge: omitting
 * `--task` drops any tasks the original note carried.
 *
 * `--force` is required when the note's kind is lifecycle-only
 * (`created`/`applied`/`status`) — those entries are the record of what the
 * helper actually did.
 *
 * @param {any} action
 */
function planNoteReplace(action) {
    const o = action.opts;
    const p = esc(action.global.project);
    const seq = Number(o.seq);
    const noteId = Number(o.id);
    const planId = resolvePlanId(p, seq);

    const existing = requireNote(planId, seq, noteId);
    guardLifecycleNote(existing, o.force);

    const { sql: statement, cleanup } = noteReplaceSql(planId, existing, { note: o.note, tasks: o.tasks });
    try {
        transaction([statement]);
    } finally {
        cleanup();
    }
    return 0;
}

/**
 * Remove one note from a plan by id. Remaining ids are untouched, so a later
 * `plan note add` still allocates MAX(id)+1 correctly — deleting id 2 out of
 * {1,2,3} leaves {1,3} and the next id is 4.
 *
 * `--force` is required when the note's kind is lifecycle-only.
 *
 * @param {any} action
 */
function planNoteDelete(action) {
    const o = action.opts;
    const p = esc(action.global.project);
    const seq = Number(o.seq);
    const noteId = Number(o.id);
    const planId = resolvePlanId(p, seq);

    const existing = requireNote(planId, seq, noteId);
    guardLifecycleNote(existing, o.force);

    transaction([noteDeleteSql(planId, noteId)]);
    return 0;
}

/** @type {Record<string, (action:any) => number|void>} */
export const HANDLERS = {
    dbInit,
    dbMigrate,
    taskAdd,
    taskUpdate,
    taskGet,
    taskList,
    taskRecent,
    taskDepsCheck,
    taskDepsValidate,
    taskDepsBlocked,
    taskDepsUnblocked,
    taskChangelogList,
    taskChangelogMark,
    planCreate,
    planGet,
    planList,
    planNoteAdd,
    planNoteList,
    planNoteReplace,
    planNoteDelete,
    ...PLAN_READ_HANDLERS,
    ...PLAN_SYNC_HANDLERS,
};
