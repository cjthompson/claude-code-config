/**
 * schema — the DDL `db init` applies, and nothing else.
 *
 * Two rules govern this file, and both are about the 350 rows already in the
 * live database:
 *
 *   1. **Create-if-missing, then additive ALTER.** No table is ever rebuilt, no
 *      data is ever copied between tables, and no `seq` is ever renumbered. A
 *      migration that loses or renumbers a row is worse than a missing feature.
 *   2. **Every added column defaults to NULL.** That is not a style preference:
 *      `ALTER TABLE … ADD COLUMN … REFERENCES` is only legal under
 *      `foreign_keys=ON` when the new column's default is NULL. Give `plan_id`
 *      a non-NULL default and `db init` starts failing on every existing
 *      database. Verified on sqlite3 3.51.0.
 *
 * `plans` must be created BEFORE the `tasks.plan_id` ALTER runs, since the
 * REFERENCES clause names it.
 */

export const CREATE_TASKS = `CREATE TABLE IF NOT EXISTS tasks(
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

export const CREATE_PLANS = `CREATE TABLE IF NOT EXISTS plans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN('inline','linked')),
    path TEXT,
    origin_path TEXT,
    content TEXT,
    content_hash TEXT,
    synced_at TEXT,
    pending_content TEXT,
    pending_hash TEXT,
    pending_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN('pending','in_progress','completed','cancelled')),
    notes TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    created TEXT NOT NULL,
    updated TEXT,
    UNIQUE(project,seq)
);`;

/**
 * Columns added to `tasks` after its initial schema, in the order they were
 * introduced. Each is applied only when absent, so this list is idempotent and
 * safe to re-run against any vintage of the database.
 *
 * `plan_anchor` is deliberately nullable with no default: the partial unique
 * index below only covers non-NULL anchors, so plan-less tasks — every one of
 * the existing rows — stay outside the index entirely.
 *
 * @type {Array<[string, string]>} [column name, ALTER statement]
 */
export const ADDITIVE_TASK_COLUMNS = [
    ['feedback', 'ALTER TABLE tasks ADD COLUMN feedback TEXT;'],
    ['completed_at', 'ALTER TABLE tasks ADD COLUMN completed_at TEXT;'],
    ['plan_id', 'ALTER TABLE tasks ADD COLUMN plan_id INTEGER REFERENCES plans(id) ON DELETE RESTRICT;'],
    ['plan_anchor', 'ALTER TABLE tasks ADD COLUMN plan_anchor TEXT;'],
    ['commit_sha', 'ALTER TABLE tasks ADD COLUMN commit_sha TEXT;'],
];

/**
 * A plan step maps to at most one task. Partial, so the 350 plan-less rows —
 * all with `plan_anchor IS NULL` — are not covered and cannot collide with each
 * other. (An *empty* anchor would be non-NULL and therefore covered, which is
 * why `lib/cli.mjs` rejects a slug that normalizes to `''` at the boundary.)
 */
export const CREATE_INDEXES = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_plan_anchor
       ON tasks(plan_id, plan_anchor) WHERE plan_anchor IS NOT NULL;`,
];
